import { json, makeRoute } from '../services/routes';
import { isDeveloper } from '../other/permissions';
import { DBUserSelectArgs } from '../other/vars';
import { db } from '../core/prisma';
import manager from '../index';

export default [
	makeRoute({
		path: '/admin/rooms',
		method: 'GET',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const rooms = [...manager.socket.roomData.values()].map((room) => ({
				boardId: room.boardId,
				elements: room.elements.length,
				collaborators: [...room.collaborators.values()].map((collaborator) => ({
					id: collaborator.id,
					socketId: collaborator.socketId,
					username: collaborator.username,
					avatarUrl: collaborator.avatarUrl,
				}))
					.filter((collaborator) => collaborator.id && collaborator.socketId && collaborator.username && collaborator.avatarUrl)
					.filter((collaborator, index, self) => self.findIndex((c) => c.id === collaborator.id) === index),
			}));

			return json(c, 200, { data: rooms });
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
