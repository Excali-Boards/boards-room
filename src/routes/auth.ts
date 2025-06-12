import { emailToUserId, parseZodError, securityUtils } from '../modules/utils';
import { makeRoute, json } from '../classes/routes';
import { Platforms } from '@prisma/client';
import config from '../modules/config';
import { db } from '../modules/prisma';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/auth',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			const isValid = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const { platform, email, displayName, avatarUrl, currentUserId } = isValid.data;

			try {
				const DBUser = await createOrLinkUser({ platform, email, displayName, avatarUrl }, currentUserId);
				if (!DBUser) return json(c, 404, { error: 'User not found or created.' });

				return json(c, 200, {
					data: {
						email: DBUser.email,
						displayName: DBUser.displayName,
						avatarUrl: DBUser.avatarUrl,
						platform,
					},
				});
			} catch (error) {
				if (error instanceof Error) return json(c, 500, { error: error.message });
				return json(c, 500, { error: 'An unexpected error occurred.' });
			}
		},
	}),
];

const sessionSchema = z.object({
	platform: z.nativeEnum(Platforms),
	email: z.string().email(),
	displayName: z.string(),
	avatarUrl: z.string().url().optional().nullable(),
	currentUserId: z.string().optional(),
});

async function createOrLinkUser({ platform, email, displayName, avatarUrl }: z.infer<typeof sessionSchema>, currentUserId?: string) {
	const encryptedEmail = securityUtils.encrypt(email);
	avatarUrl = avatarUrl || `https://gravatar.com/avatar/${securityUtils.hash(email)}?d=mp`;

	const existingLoginMethod = await db(manager, 'loginMethod', 'findUnique', {
		where: {
			platform_platformEmail: {
				platform,
				platformEmail: encryptedEmail,
			},
		},
		include: { user: true },
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

			return await db(manager, 'user', 'findUnique', { where: { userId: currentUserId }, select: { email: true, displayName: true, avatarUrl: true } });
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
			email: true,
			displayName: true,
			avatarUrl: true,
		},
	});

	if (!user) throw new Error('Failed to create or update user.');
	return user;
}
