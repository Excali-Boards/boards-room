import { parseZodError } from '../modules/functions.js';
import { json, makeRoute } from '../services/routes.js';
import { DBUserSelectArgs } from '../other/vars.js';
import { allowedPlatforms } from '../core/config.js';
import { Platforms, User } from '@prisma/client';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	// Current user.
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

			const tryUpdate = await updateUserInfo(c.var.DBUser.userId, isValid.data).catch((err) => err);
			if (tryUpdate instanceof Error) return json(c, 400, { error: tryUpdate.message });

			return json(c, 200, { data: 'User updated successfully.' });
		},
	}),
	makeRoute({
		path: '/users',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const tryDelete = await deleteUser(c.var.DBUser.userId).catch((err) => err);
			if (tryDelete instanceof Error) return json(c, 400, { error: tryDelete.message });

			return json(c, 200, { data: 'Your account has been deleted.' });
		},
	}),

	// Other users.
	makeRoute({
		path: '/users/:userId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			if (!c.var.isDev && userId !== c.var.DBUser.userId) return json(c, 403, { error: 'You do not have permission to access this user\'s information.' });

			const DBUser = await getUserInfo(userId);
			if (!DBUser) return json(c, 404, { error: 'User not found.' });

			return json(c, 200, { data: DBUser });
		},
	}),
	makeRoute({
		path: '/users/:userId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			if (!c.var.isDev && userId !== c.var.DBUser.userId) return json(c, 403, { error: 'You do not have permission to update this user.' });

			const isValid = userSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const tryUpdate = await updateUserInfo(userId, isValid.data).catch((err) => err);
			if (tryUpdate instanceof Error) return json(c, 400, { error: tryUpdate.message });

			return json(c, 200, { data: 'User updated successfully.' });
		},
	}),
	makeRoute({
		path: '/users/:userId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			if (!c.var.isDev && userId !== c.var.DBUser.userId) return json(c, 403, { error: 'You do not have permission to delete this user.' });

			const tryDelete = await deleteUser(userId).catch((err) => err);
			if (tryDelete instanceof Error) return json(c, 400, { error: tryDelete.message });

			return json(c, 200, { data: 'User deleted successfully.' });
		},
	}),
];

// Functions.
export async function getUserInfo(userId: string) {
	return await db(manager, 'user', 'findUnique', {
		where: { userId },
		...DBUserSelectArgs,
	});
}

export async function updateUserInfo(userId: string, data: Partial<UserInput>) {
	const updateData: Partial<User> = {};

	if (data.displayName) updateData.displayName = data.displayName;

	if (data.platform) {
		if (!allowedPlatforms.includes(data.platform.toLowerCase() as Lowercase<Platforms>)) throw new Error('Invalid platform.');

		const DBUser = await db(manager, 'user', 'findUnique', {
			where: { userId },
			select: { loginMethods: true },
		});
		if (!DBUser) throw new Error('User not found.');

		const platformInfo = DBUser.loginMethods.find((method) => method.platform === data.platform);
		if (!platformInfo) throw new Error('You must connect to the platform you want to set as main first.');

		updateData.email = platformInfo.platformEmail;
		updateData.mainLoginType = data.platform;
	}

	if (data.mainGroupId !== undefined) {
		const DBGroup = data.mainGroupId ? await db(manager, 'group', 'findUnique', { where: { groupId: data.mainGroupId } }) : null;
		if (data.mainGroupId && !DBGroup) throw new Error('Group not found.');

		updateData.mainGroupId = data.mainGroupId;
	}

	if (Object.keys(updateData).length > 0) {
		await db(manager, 'user', 'update', {
			where: { userId },
			data: updateData,
		});
	}
}

export async function deleteUser(userId: string) {
	await db(manager, 'user', 'delete', { where: { userId } });

	const allRooms = [
		...manager.socket.excalidrawSocket.roomData.values(),
		...manager.socket.tldrawSocket.roomData.values(),
	];

	for (const room of allRooms) {
		for (const [socketId, collaborator] of room.collaborators) {
			if (collaborator.id === userId) {
				room.collaborators.delete(socketId);

				const socket = manager.socket.io.sockets.sockets.get(socketId);
				if (socket) socket.disconnect(true);
			}
		}
	}
}

// Schema.
export type UserInput = z.infer<typeof userSchema>;
export const userSchema = z.object({
	platform: z.enum(Platforms).optional(),
	mainGroupId: z.string().optional().nullable(),
	displayName: z.string().min(3).max(40).optional(),
});
