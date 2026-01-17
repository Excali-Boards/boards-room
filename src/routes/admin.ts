import { json, makeRoute } from '../services/routes.js';
import { isDeveloper } from '../other/permissions.js';
import { DBUserSelectArgs } from '../other/vars.js';
import { db } from '../core/prisma.js';
import { AllRooms } from '../types.js';
import manager from '../index.js';

export default [
	makeRoute({
		path: '/admin/rooms',
		method: 'GET',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const allRooms: AllRooms = [];

			for (const room of manager.socket.excalidrawSocket.roomData.values()) {
				allRooms.push({
					boardId: room.boardId,
					elements: room.elements.length,
					type: 'Excalidraw',
					collaborators: [...room.collaborators.values()].map((collaborator) => ({
						id: collaborator.id!,
						socketId: collaborator.socketId!,
						username: collaborator.username!,
						avatarUrl: collaborator.avatarUrl || null,
					}))
						.filter((collaborator) => collaborator.id && collaborator.socketId && collaborator.username)
						.filter((collaborator, index, self) => self.findIndex((c) => c.id === collaborator.id) === index),
				});
			}

			for (const room of manager.socket.tldrawSocket.roomData.values()) {
				allRooms.push({
					boardId: room.boardId,
					elements: room.room.getCurrentSnapshot().documents.length,
					type: 'Tldraw',
					collaborators: [...room.collaborators.values()].map((collaborator) => ({
						id: collaborator.id!,
						socketId: collaborator.socketId!,
						username: collaborator.username!,
						avatarUrl: collaborator.avatarUrl || null,
					}))
						.filter((collaborator) => collaborator.id && collaborator.socketId && collaborator.username)
						.filter((collaborator, index, self) => self.findIndex((c) => c.id === collaborator.id) === index),
				});
			}

			return json(c, 200, { data: allRooms });
		},
	}),
	makeRoute({
		path: '/admin/users',
		method: 'GET',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const page = parseInt(c.req.query('page') || '1');
			const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
			const skip = (page - 1) * limit;

			const [DBUsers, total] = await Promise.all([
				db(manager, 'user', 'findMany', {
					where: {},
					skip, take: limit,
					orderBy: { dbId: 'asc' },
					...DBUserSelectArgs,
				}),
				db(manager, 'user', 'count', { where: {} }),
			]);

			if (!DBUsers || total === null) return json(c, 500, { error: 'Failed to retrieve users.' });

			return json(c, 200, {
				data: {
					data: DBUsers.map((user) => ({
						...user,
						isDev: isDeveloper(user.email),
					})),
					pagination: {
						page,
						limit,
						total,
						hasMore: skip + DBUsers.length < total,
					},
				},
			});
		},
	}),
];
