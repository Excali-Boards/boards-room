import { parseZodError } from '../modules/functions.js';
import { json, makeRoute } from '../services/routes.js';
import { allowedPlatforms } from '../core/config.js';
import { Platforms, User } from '@prisma/client';
import { db } from '../core/prisma.js';
import manager from '../index.js';
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

			const updateData: Partial<User> = {};

			if (isValid.data.displayName) updateData.displayName = isValid.data.displayName;

			if (isValid.data.platform) {
				if (!allowedPlatforms.includes(isValid.data.platform.toLowerCase() as Lowercase<Platforms>)) return json(c, 400, { error: 'Invalid platform.' });

				const platformInfo = c.var.DBUser.loginMethods.find((method) => method.platform === isValid.data.platform);
				if (!platformInfo) return json(c, 400, { error: 'You must connect to the platform you want to set as main first.' });

				updateData.email = platformInfo.platformEmail;
				updateData.mainLoginType = isValid.data.platform;
			}

			if (isValid.data.mainGroupId !== undefined) {
				const DBGroup = isValid.data.mainGroupId ? await db(manager, 'group', 'findUnique', { where: { groupId: isValid.data.mainGroupId } }) : null;
				if (isValid.data.mainGroupId && !DBGroup) return json(c, 404, { error: 'Group not found.' });

				updateData.mainGroupId = isValid.data.mainGroupId;
			}

			if (Object.keys(updateData).length > 0) {
				await db(manager, 'user', 'update', {
					where: { userId: c.var.DBUser.userId },
					data: updateData,
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

			const allRooms = [
				...manager.socket.excalidrawSocket.roomData.values(),
				...manager.socket.tldrawSocket.roomData.values(),
			];

			for (const room of allRooms) {
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
	displayName: z.string().min(3).max(40).optional(),
});
