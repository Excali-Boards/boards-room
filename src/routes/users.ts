import { parseZodError } from '../modules/functions';
import { json, makeRoute } from '../services/routes';
import { allowedPlatforms } from '../core/config';
import { Platforms } from '@prisma/client';
import { db } from '../core/prisma';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/users',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			return json(c, 200, {
				data: {
					...c.var.DBUser,
					isDev: c.var.isDev,
				},
			});
		},
	}),
	makeRoute({
		path: '/users',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = userSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			if (isValid.data.platform) {
				if (!allowedPlatforms.includes(isValid.data.platform.toLowerCase() as Lowercase<Platforms>)) return json(c, 400, { error: 'Invalid platform.' });

				const platformInfo = c.var.DBUser.loginMethods.find((method) => method.platform === isValid.data.platform);
				if (!platformInfo) return json(c, 400, { error: 'You must connect to the platform you want to set as main first.' });

				await db(manager, 'user', 'update', {
					where: { userId: c.var.DBUser.userId },
					data: {
						email: platformInfo.platformEmail,
						mainLoginType: isValid.data.platform,
					},
				}, false);
			}

			if (isValid.data.mainGroupId) {
				if (isValid.data.mainGroupId) {
					const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId: isValid.data.mainGroupId } });
					if (!DBGroup) return json(c, 404, { error: 'Group not found.' });
				}

				await db(manager, 'user', 'update', {
					where: { userId: c.var.DBUser.userId },
					data: { mainGroupId: isValid.data.mainGroupId },
				});
			}

			return json(c, 200, { data: 'User updated successfully.' });
		},
	}),
	makeRoute({
		path: '/users',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			await db(manager, 'user', 'delete', { where: { userId: c.var.DBUser.userId } });

			for (const room of manager.socket.roomData.values()) {
				for (const [socketId, collaborator] of room.collaborators) {
					if (collaborator.id === c.var.DBUser.userId) {
						room.collaborators.delete(socketId);

						const socket = manager.socket.io.sockets.sockets.get(socketId);
						if (socket) socket.disconnect(true);
					}
				}
			}

			return json(c, 200, { data: 'Your account has been deleted.' });
		},
	}),
];

export type UserInput = z.infer<typeof userSchema>;
export const userSchema = z.object({
	platform: z.enum(Platforms).optional(),
	mainGroupId: z.string().optional().nullable(),
});
