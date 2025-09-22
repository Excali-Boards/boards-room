import { emailToUserId, parseZodError, securityUtils } from '../modules/functions';
import { makeRoute, json } from '../services/routes';
import { Device, Platforms } from '@prisma/client';
import config from '../core/config';
import { db } from '../core/prisma';
import manager from '../index';
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

			const DBUser = await createOrLinkUser(isValid.data);
			if (!DBUser) return json(c, 404, { error: 'User not found or created.' });

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

async function createOrLinkUser({ platform, email, displayName, avatarUrl, currentUserId }: SessionInput) {
	const encryptedEmail = securityUtils.encrypt(email);
	avatarUrl = avatarUrl || `https://gravatar.com/avatar/${securityUtils.hash(email)}?d=mp`;

	const existingLoginMethod = await db(manager, 'loginMethod', 'findUnique', {
		include: { user: { select: { userId: true, email: true, displayName: true, avatarUrl: true, sessions: { select: { dbId: true, lastUsed: true } } } } },
		where: {
			platform_platformEmail: {
				platform,
				platformEmail: encryptedEmail,
			},
		},
	});

	if (currentUserId) {
		if (!existingLoginMethod) {
			await db(manager, 'loginMethod', 'create', {
				data: {
					platform,
					platformEmail: encryptedEmail,
					user: { connect: { userId: currentUserId } },
				},
			});

			return await db(manager, 'user', 'findUnique', {
				where: { userId: currentUserId },
				select: { userId: true, email: true, displayName: true, avatarUrl: true, sessions: { select: { dbId: true, lastUsed: true } } },
			});
		} else if (existingLoginMethod.userId !== currentUserId) {
			throw new Error('This login method is linked to another user.');
		}

		return existingLoginMethod.user;
	}

	if (existingLoginMethod) return existingLoginMethod.user;

	const user = await db(manager, 'user', 'upsert', {
		where: { email: encryptedEmail },
		update: {
			mainLoginType: platform,
			displayName,
			avatarUrl,
		},
		create: {
			userId: emailToUserId(encryptedEmail),
			email: encryptedEmail,
			mainLoginType: platform,
			displayName,
			avatarUrl,
			loginMethods: {
				create: { platform, platformEmail: encryptedEmail },
			},
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
