import { json, makeRoute } from '../services/routes.js';
import { isDeveloper } from '../other/permissions.js';
import { DBUserSelectArgs } from '../other/vars.js';
import { db } from '../core/prisma.js';
import { AllRooms } from '../types.js';
import manager from '../index.js';
import { parseZodError, compressionUtils } from '../modules/functions.js';
import { Readable } from 'node:stream';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/admin/boards/:boardId/content',
		method: 'GET',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const file = await manager.files.getBoardFile(boardId);
			if (!file?.Body) return json(c, 404, { error: 'Board file not found in S3.' });

			try {
				const body = await manager.files.readableToBuffer(file.Body as Readable);
				const content = compressionUtils.decompressAndDecrypt<unknown>(body);
				return json(c, 200, { data: { boardId, type: Array.isArray(content) ? 'Excalidraw' : 'Tldraw', content } });
			} catch {
				return json(c, 400, { error: 'Failed to decode board file.' });
			}
		},
	}),
	makeRoute({
		path: '/admin/boards/:boardId/resolve',
		method: 'POST',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const input = resolveBoardSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!input.success) return json(c, 400, { error: parseZodError(input.error) });

			const boardFileIds = await manager.files.getBoardFileIds();
			if (!boardFileIds) return json(c, 500, { error: 'Failed to retrieve board files from S3.' });
			if (!boardFileIds.includes(boardId)) return json(c, 404, { error: 'Board file not found in S3.' });

			const category = await manager.prisma.category.findUnique({
				where: { categoryId: input.data.categoryId },
				select: { categoryId: true, groupId: true, group: { select: { personalWorkspace: { select: { dbId: true } } } } },
			});
			if (!category) return json(c, 404, { error: 'Category not found.' });
			if (category.group.personalWorkspace) return json(c, 400, { error: 'Boards cannot be linked to a personal category.' });

			const existingBoard = await manager.prisma.board.findUnique({ where: { boardId }, select: { boardId: true } });
			const maxIndex = await manager.prisma.board.aggregate({ where: { categoryId: category.categoryId }, _max: { index: true } });
			const board = existingBoard
				? await manager.prisma.board.update({ where: { boardId }, data: { name: input.data.name, type: input.data.type, categoryId: category.categoryId } })
				: await manager.prisma.board.create({ data: { boardId, name: input.data.name, type: input.data.type, categoryId: category.categoryId, index: (maxIndex._max.index ?? -1) + 1 } });

			return json(c, 200, { data: { boardId: board.boardId, name: board.name, categoryId: category.categoryId } });
		},
	}),
	makeRoute({
		path: '/admin/boards',
		method: 'GET',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const boardIds = await manager.files.getBoardFileIds();
			if (!boardIds) return json(c, 500, { error: 'Failed to retrieve board files from S3.' });

			const DBBoards = await manager.prisma.board.findMany({
				where: { boardId: { in: boardIds } },
				select: {
					boardId: true,
					name: true,
					type: true,
					categoryId: true,
					category: {
						select: {
							categoryId: true,
							name: true,
							groupId: true,
							group: { select: { groupId: true, name: true, personalWorkspace: { select: { userId: true } } } },
						},
					},
				},
			});

			const boardsById = new Map(DBBoards.map((board) => [board.boardId, board]));
			return json(c, 200, {
				data: boardIds.map((boardId) => {
					const board = boardsById.get(boardId);
					if (!board) return { boardId, board: null };

					return {
						boardId,
						board: {
							id: board.boardId,
							name: board.name,
							type: board.type,
							groupId: board.category.group.groupId,
							groupName: board.category.group.name,
							categoryId: board.category.categoryId,
							categoryName: board.category.name,
							isPersonal: board.category.group.personalWorkspace !== null,
							userId: board.category.group.personalWorkspace?.userId || null,
						},
					};
				}),
			});
		},
	}),
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

			const recentlyActiveRooms = [...manager.socket.recentlyActiveRooms.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);

			return json(c, 200, {
				data: {
					rooms: allRooms,
					recentlyActiveRooms,
				},
			});
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

const resolveBoardSchema = z.object({
	name: z.string().trim().min(1).max(200),
	categoryId: z.string().min(1),
	type: z.enum(['Excalidraw', 'Tldraw']),
});
