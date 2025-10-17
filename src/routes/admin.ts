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
			const DBUsers = await db(manager, 'user', 'findMany', { where: {}, ...DBUserSelectArgs }) || [];

			return json(c, 200, {
				data: DBUsers.map((user) => ({
					...user,
					isDev: isDeveloper(user.email),
				})),
			});
		},
	}),
];
