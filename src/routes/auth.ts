import { parseZodError, securityUtils } from '../modules/functions.js';
import { createOrLinkUser, sessionSchema, trimSessions } from './sessions.js';
import { makeRoute, json } from '../services/routes.js';
import config from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';

export default [
	makeRoute({
		path: '/auth/authenticate',
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
			const locationEncrypted = location ? securityUtils.encryptRandom(location) : null;

			await db(manager, 'session', 'create', {
				data: {
					token,
					device: isValid.data.device,
					locationEncrypted,
					userId: DBUser.userId,
					expiresAt,
				},
			});

			await trimSessions(DBUser.userId, token);

			return json(c, 200, {
				data: {
					...DBUser,
					token,
					expiresAt,
				},
			});
		},
	}),
];
