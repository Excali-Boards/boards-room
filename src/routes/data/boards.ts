import { compressionUtils, parseZodError, securityUtils } from '../../modules/functions';
import { getAccessLevel, isDeveloper, canManage } from '../../other/permissions';
import { json, makeRoute } from '../../services/routes';
import config, { nameObject } from '../../core/config';
import { DBUserPartial } from '../../other/vars';
import { db } from '../../core/prisma';
import manager from '../../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateBoard = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canCreateBoard) return json(c, 403, { error: 'You do not have permission to create boards in this category.' });

			const totalBoards = await db(manager, 'board', 'findMany', { where: { categoryId, category: { groupId } }, select: { index: true } });
			const newBoard = await db(manager, 'board', 'create', {
				data: {
					name: isValid.data.name,
					boardId: securityUtils.randomString(12),
					categoryId,
					index: (totalBoards && totalBoards.length > 0 ? Math.max(...totalBoards.map((b) => b.index)) + 1 : 0),
				},
			});

			if (!newBoard) return json(c, 500, { error: 'Failed to create board.' });

			const compressed = compressionUtils.compressAndEncrypt([]);
			const uploaded = await manager.files.uploadBoardFile(newBoard.boardId, compressed, 'application/octet-stream');
			if (!uploaded) return json(c, 500, { error: 'Failed to upload board file.' });

			return json(c, 200, { data: 'Board created successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid board order.' });

			const canReorderBoards = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canReorderBoards) return json(c, 403, { error: 'You do not have permission to reorder boards in this category.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			const DBBoards = await db(manager, 'board', 'findMany', { where: { categoryId, category: { groupId }, boardId: { in: isValid.data } } }) || [];
			if (DBBoards.length !== isValid.data.length) return json(c, 400, { error: 'Some boards do not belong to this category.' });

			const updatePromises = isValid.data.map((boardId, index) =>
				db(manager, 'board', 'update', {
					where: { boardId },
					data: { index },
					select: { boardId: true },
				}),
			);

			await Promise.all(updatePromises);

			return json(c, 200, { data: 'Boards reordered successfully.' });
		},
	}),

	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const accessLevelCategory = getAccessLevel(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			const accessLevelGroup = getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId } });

			const DBBoard = await db(manager, 'board', 'findUnique', {
				where: { boardId, categoryId, category: { groupId } },
				select: {
					boardId: true,
					name: true,
					index: true,
					totalSizeBytes: true,
					scheduledForDeletion: true,
					files: {
						select: {
							fileId: true,
							mimeType: true,
							createdAt: true,
							sizeBytes: true,
						},
					},
					category: {
						select: {
							categoryId: true,
							name: true,
							index: true,
							group: {
								select: {
									groupId: true,
									name: true,
									index: true,
								},
							},
						},
					},
				},
			});

			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			return json(c, 200, {
				data: {
					isDev: c.var.isDev,
					group: {
						id: DBBoard.category.group.groupId,
						name: DBBoard.category.group.name,
						index: DBBoard.category.group.index,
						accessLevel: accessLevelGroup || 'read',
					},
					category: {
						id: DBBoard.category.categoryId,
						name: DBBoard.category.name,
						index: DBBoard.category.index,
						accessLevel: accessLevelCategory || 'read',
					},
					board: {
						id: DBBoard.boardId,
						name: DBBoard.name,
						index: DBBoard.index,
						accessLevel: accessLevel,
						totalSizeBytes: DBBoard.totalSizeBytes,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${DBBoard.boardId}.bin`,
						scheduledForDeletion: DBBoard.scheduledForDeletion,
						files: DBBoard.files.map((file) => ({
							fileId: file.fileId,
							mimeType: file.mimeType,
							createdAt: file.createdAt,
							fileUrl: `${config.s3.endpoint}/${config.s3.bucket}/${DBBoard.boardId}/${file.fileId}`,
						})),
					},
				},
			});
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canUpdateBoard = canManage(c.var.DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
			if (!canUpdateBoard) return json(c, 403, { error: 'You do not have permission to update this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const updatedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { name: isValid.data.name } });
			if (!updatedBoard) return json(c, 500, { error: 'Failed to update board.' });

			return json(c, 200, { data: 'Successfully updated board.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const canDeleteBoard = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canDeleteBoard) return json(c, 403, { error: 'You do not have permission to delete this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const scheduledForDeletion = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

			const deletedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { scheduledForDeletion } });
			if (!deletedBoard) return json(c, 500, { error: 'Failed to delete board.' });

			return json(c, 200, { data: 'Board scheduled for deletion.' });
		},
	}),

	// Ohter board.
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId/room',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const RoomData = manager.socket.roomData.get(boardId);
			if (!RoomData) return json(c, 404, { error: 'Board not found or no one is currently collaborating.' });

			return json(c, 200, {
				data: {
					boardId: RoomData.boardId,
					elements: RoomData.elements,
					collaborators: [...RoomData.collaborators.values()].map((collaborator) => ({
						id: collaborator.id,
						socketId: collaborator.socketId,
						username: collaborator.username,
						avatarUrl: collaborator.avatarUrl,
					})).filter((collaborator) => collaborator.id && collaborator.socketId && collaborator.username && collaborator.avatarUrl),
				},
			});
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId/room',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const userId = c.req.query('userId');
			if (!userId) return json(c, 400, { error: 'User ID is required.' });

			const TargetUser = await db(manager, 'user', 'findUnique', { where: { userId }, ...DBUserPartial });
			if (!TargetUser) return json(c, 404, { error: 'User not found.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const RoomData = manager.socket.roomData.get(boardId);
			if (!RoomData) return json(c, 404, { error: 'Board not found or no one is currently collaborating.' });

			const targetIsSelf = c.var.DBUser.userId === userId;
			if (targetIsSelf) return json(c, 400, { error: 'You cannot kick yourself from the room.' });

			const targetIsDev = isDeveloper(TargetUser.email);
			const isCurrentUserDev = c.var.isDev;

			if (!isCurrentUserDev) {
				if (targetIsDev) return json(c, 403, { error: 'You cannot kick a developer.' });

				const targetAccessLevel = getAccessLevel(TargetUser, { type: 'board', data: { boardId, categoryId, groupId } });
				if (!targetAccessLevel) return json(c, 400, { error: 'The target user does not have access to this board.' });
				else if (targetAccessLevel !== 'read') return json(c, 400, { error: 'The target user has more than read access to this board.' });
			}

			const kicked = await manager.socket.kickUser(boardId, userId);
			if (!kicked) return json(c, 404, { error: 'User not found in the room.' });

			return json(c, 200, { data: `User ${kicked} kicked from the room.` });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards/:boardId/cancel-deletion',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const canCancelDeletion = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canCancelDeletion) return json(c, 403, { error: 'You do not have permission to cancel deletion of this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const updatedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { scheduledForDeletion: null } });
			if (!updatedBoard) return json(c, 500, { error: 'Failed to cancel deletion of board.' });

			return json(c, 200, { data: 'Successfully cancelled deletion of board.' });
		},
	}),
];
