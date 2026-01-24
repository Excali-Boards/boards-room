import { emailToUserId, parseZodError, securityUtils } from '../modules/functions.js';
import { DBUserPartialType, DBUserSelectArgs } from '../other/vars.js';
import { makeRoute, json } from '../services/routes.js';
import { Device, Platforms } from '@prisma/client';
import config from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/sessions',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const sessions = await db(manager, 'session', 'findMany', {
				where: { userId: c.var.DBUser.userId, expiresAt: { gt: new Date() } },
				select: { dbId: true, token: true, expiresAt: true, locationEncrypted: true, createdAt: true, lastUsed: true, device: true },
				orderBy: { lastUsed: 'desc' },
			}) || [];

			const currentSession = sessions.find((s) => s.token === c.var.token);
			if (!currentSession) return json(c, 401, { error: 'Current session not found.' });

			const safeSessions = sessions.map((session) => ({
				dbId: session.dbId,
				location: session.locationEncrypted ? securityUtils.decrypt(session.locationEncrypted) : null,
				tokenPreview: session.token.slice(0, 15) + '..', // Token is 128 characters long.
				expiresAt: session.expiresAt,
				createdAt: session.createdAt,
				lastUsed: session.lastUsed,
				device: session.device,
			}));

			return json(c, 200, {
				data: {
					activeDbId: currentSession.dbId,
					sessions: safeSessions,
				},
			});
		},
	}),
	makeRoute({
		path: '/sessions',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			const isValid = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const DBUser = await createOrLinkUser(isValid.data).catch((err: Error) => err);

			if (!DBUser) return json(c, 404, { error: 'User creation or linking failed.' });
			else if (DBUser instanceof Error) return json(c, 404, { error: DBUser.message });

			const token = securityUtils.randomString(128);
			const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

			const location = isValid.data.ip ? await manager.utils.getIpLocation(isValid.data.ip) : null;
			const locationEncrypted = location ? securityUtils.encrypt(location) : null;

			await db(manager, 'session', 'create', {
				data: {
					token,
					locationEncrypted,
					userId: DBUser.userId,
					expiresAt,
				},
			});

			if (DBUser.sessions && DBUser.sessions.length >= 5) {
				const oldestSession = DBUser.sessions.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime())[0];
				if (oldestSession) await db(manager, 'session', 'delete', { where: { dbId: oldestSession.dbId } });
			}

			return json(c, 200, {
				data: {
					token,
					expiresAt,
				},
			});
		},
	}),
	makeRoute({
		path: '/sessions/rotate',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = unlinkLoginMethodSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const tryUnlink = await unlinkLoginMethod(c.var.DBUser.userId, isValid.data).catch((err: Error) => err);
			if (!tryUnlink) return json(c, 404, { error: 'Login method unlinking failed.' });
			else if (tryUnlink instanceof Error) return json(c, 400, { error: tryUnlink.message });

			return json(c, 200, { data: 'Login method updated.' });
		},
	}),
	makeRoute({
		path: '/sessions',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = sessionDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const session = await db(manager, 'session', 'findUnique', { where: { dbId: isValid.data.dbId } });
			if (!session || session.userId !== c.var.DBUser.userId) return json(c, 404, { error: 'Session not found.' });

			await db(manager, 'session', 'delete', { where: { dbId: isValid.data.dbId } });
			return json(c, 200, { data: 'Successfully deleted session.' });
		},
	}),
	makeRoute({
		path: '/sessions/all',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const result = await db(manager, 'session', 'deleteMany', { where: { userId: c.var.DBUser.userId } });
			return json(c, 200, { data: `Successfully deleted ${result?.count || 0} sessions.` });
		},
	}),
];

// Schemas.
export type SessionInput = z.infer<typeof sessionSchema>;
export const sessionSchema = z.object({
	platform: z.enum(Platforms),
	email: z.email(),
	displayName: z.string(),
	avatarUrl: z.url().optional().nullable(),
	currentUserId: z.string().optional(),
	device: z.enum(Device).optional(),
	ip: z.string().optional(),
});

export type SessionDeleteInput = z.infer<typeof sessionDeleteSchema>;
export const sessionDeleteSchema = z.object({
	dbId: z.string(),
});

export type UnlinkLoginMethodInput = z.infer<typeof unlinkLoginMethodSchema>;
export const unlinkLoginMethodSchema = z.object({
	platform: z.enum(Platforms),
	email: z.email().optional(),
	newMainPlatform: z.enum(Platforms).optional(),
});

// Types and functions.
export type SessionOutput = Pick<DBUserPartialType, 'userId' | 'email' | 'displayName' | 'avatarUrl'> & {
	sessions: { dbId: string; lastUsed: Date; }[];
};

async function createOrLinkUser({ platform, email, displayName, avatarUrl, currentUserId }: SessionInput): Promise<SessionOutput | null> {
	const encryptedEmail = securityUtils.encrypt(email);
	const finalAvatarUrl = avatarUrl || `https://gravatar.com/avatar/${securityUtils.hash(email)}?d=mp`;

	const existingLoginMethod = await db(manager, 'loginMethod', 'findUnique', {
		include: { user: { select: { userId: true, email: true, displayName: true, avatarUrl: true, sessions: { select: { dbId: true, lastUsed: true } } } } },
		where: { platform_platformEmail: { platform, platformEmail: encryptedEmail } },
	});

	// Link to existing user
	if (currentUserId) {
		if (existingLoginMethod && existingLoginMethod.userId !== currentUserId) {
			throw new Error('This login method is linked to another user.');
		}

		const currentUser = await db(manager, 'user', 'findUnique', {
			where: { userId: currentUserId },
			select: {
				userId: true,
				email: true,
				displayName: true,
				avatarUrl: true,
				mainLoginType: true,
				sessions: { select: { dbId: true, lastUsed: true } },
				loginMethods: { select: { dbId: true, platform: true, platformEmail: true } },
			},
		});

		if (!currentUser) throw new Error('User not found.');

		const platformMethods = currentUser.loginMethods.filter((m) => m.platform === platform);
		const primaryMethod = platformMethods[0];

		if (primaryMethod) {
			if (primaryMethod.platformEmail !== encryptedEmail) {
				await db(manager, 'loginMethod', 'update', {
					where: { dbId: primaryMethod.dbId },
					data: { platformEmail: encryptedEmail },
				});

				if (currentUser.mainLoginType === platform) {
					await db(manager, 'user', 'update', {
						where: { userId: currentUserId },
						data: { email: encryptedEmail },
					});
					currentUser.email = encryptedEmail;
				}
			}

			const duplicates = platformMethods.slice(1);
			if (duplicates.length > 0) {
				await db(manager, 'loginMethod', 'deleteMany', {
					where: { dbId: { in: duplicates.map((m) => m.dbId) } },
				});
			}
		} else if (!existingLoginMethod) {
			await db(manager, 'loginMethod', 'create', {
				data: {
					platform,
					platformEmail: encryptedEmail,
					user: { connect: { userId: currentUserId } },
				},
			});
		}

		return {
			userId: currentUser.userId,
			email: currentUser.email,
			displayName: currentUser.displayName,
			avatarUrl: currentUser.avatarUrl,
			sessions: currentUser.sessions,
		};
	}

	// Update existing user
	if (existingLoginMethod) {
		if (existingLoginMethod.platformEmail !== encryptedEmail) {
			await db(manager, 'loginMethod', 'update', {
				where: { dbId: existingLoginMethod.dbId },
				data: { platformEmail: encryptedEmail },
			});
		}

		return await db(manager, 'user', 'update', {
			where: { userId: existingLoginMethod.userId },
			data: { mainLoginType: platform, displayName, avatarUrl: finalAvatarUrl, email: encryptedEmail },
			select: {
				userId: true,
				email: true,
				displayName: true,
				avatarUrl: true,
				sessions: { select: { dbId: true, lastUsed: true } },
			},
		});
	}

	// Create new user
	const user = await db(manager, 'user', 'upsert', {
		where: { email: encryptedEmail },
		update: {
			mainLoginType: platform,
			displayName,
			avatarUrl: finalAvatarUrl,
			loginMethods: {
				connectOrCreate: {
					where: { platform_platformEmail: { platform, platformEmail: encryptedEmail } },
					create: { platform, platformEmail: encryptedEmail },
				},
			},
		},
		create: {
			userId: emailToUserId(encryptedEmail),
			email: encryptedEmail,
			mainLoginType: platform,
			displayName,
			avatarUrl: finalAvatarUrl,
			loginMethods: { create: { platform, platformEmail: encryptedEmail } },
		},
		select: {
			userId: true,
			email: true,
			displayName: true,
			avatarUrl: true,
			sessions: { select: { dbId: true, lastUsed: true } },
		},
	});

	if (!user) throw new Error('Failed to create or update user.');
	return user;
}

async function unlinkLoginMethod(userId: string, data: UnlinkLoginMethodInput): Promise<DBUserPartialType | null> {
	const loginMethods = await db(manager, 'loginMethod', 'findMany', { where: { userId } });

	if (!loginMethods || loginMethods.length === 0) throw new Error('User not found.');
	if (loginMethods.length <= 1) throw new Error('You must keep at least one login method.');

	const target = loginMethods.find((m) => m.platform === data.platform);
	if (!target) throw new Error('Login method not found.');

	const user = await db(manager, 'user', 'findUnique', { where: { userId }, select: { mainLoginType: true } });
	if (!user) throw new Error('User not found.');

	if (user.mainLoginType === target.platform) throw new Error('Cannot unlink your main login method. Change your main login method first.');

	await db(manager, 'loginMethod', 'delete', { where: { dbId: target.dbId } });
	return await db(manager, 'user', 'findUnique', { where: { userId }, ...DBUserSelectArgs });
}
