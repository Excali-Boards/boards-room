import { isDeveloper, canManage, getBoardAccessLevel, getCategoryAccessLevel, getGroupAccessLevel, canManageBoardWithIds, getUserHighestRole, PermissionHierarchy } from '../other/permissions.js';
import { compressionUtils, parseZodError, securityUtils } from '../modules/functions.js';
import config, { boardObject, nameObject } from '../core/config.js';
import { json, makeRoute } from '../services/routes.js';
import { DBUserPartial } from '../other/vars.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const isValid = boardObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateBoard = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canCreateBoard) return json(c, 403, { error: 'You do not have permission to create boards in this category.' });

			const totalBoards = await db(manager, 'board', 'findMany', { where: { categoryId, category: { groupId } }, select: { index: true } });
			const newBoard = await db(manager, 'board', 'create', {
				data: {
					name: isValid.data.name,
					type: isValid.data.type,
					categoryId,
					boardId: securityUtils.randomString(12),
					index: (totalBoards && totalBoards.length > 0 ? Math.max(...totalBoards.map((b) => b.index)) + 1 : 0),
				},
			});

			if (!newBoard) return json(c, 500, { error: 'Failed to create board.' });

			const compressed = compressionUtils.compressAndEncrypt(newBoard.type === 'Excalidraw' ? [] : {});
			const uploaded = await manager.files.uploadBoardFile(newBoard.boardId, compressed, 'application/octet-stream').catch(() => null);
			if (!uploaded) {
				await db(manager, 'board', 'deleteMany', { where: { boardId: newBoard.boardId } }).catch(() => null);
				return json(c, 500, { error: 'Failed to upload board file.' });
			}

			return json(c, 200, { data: 'Board created successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards',
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
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const accessLevel = getBoardAccessLevel(c.var.DBUser, boardId, categoryId, groupId);
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const accessLevelCategory = getCategoryAccessLevel(c.var.DBUser, categoryId, groupId);
			const accessLevelGroup = getGroupAccessLevel(c.var.DBUser, groupId);

			const DBBoard = await db(manager, 'board', 'findUnique', {
				where: { boardId, categoryId, category: { groupId } },
				select: {
					boardId: true,
					name: true,
					type: true,
					index: true,
					totalSizeBytes: true,
					scheduledForDeletion: true,
					flashcardDeck: {
						select: {
							deckId: true,
						},
					},
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
						type: DBBoard.type,
						index: DBBoard.index,
						accessLevel: accessLevel,
						totalSizeBytes: DBBoard.totalSizeBytes,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${DBBoard.boardId}.bin`,
						scheduledForDeletion: DBBoard.scheduledForDeletion,
						hasFlashcards: DBBoard.flashcardDeck !== null,
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
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canUpdateBoard = canManageBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canUpdateBoard) return json(c, 403, { error: 'You do not have permission to update this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const updatedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { name: isValid.data.name } });
			if (!updatedBoard) return json(c, 500, { error: 'Failed to update board.' });

			return json(c, 200, { data: 'Successfully updated board.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const canDeleteBoard = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canDeleteBoard) return json(c, 403, { error: 'You do not have permission to delete this board.' });

			const force = c.req.query('force') === 'true';
			if (force && !c.var.isDev) return json(c, 403, { error: 'Only developers can force delete boards.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } }, include: { files: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			if (force) {
				const deletedBoard = await manager.utils.deleteBoard(DBBoard);
				if (!deletedBoard) return json(c, 500, { error: 'Failed to delete board.' });
				return json(c, 200, { data: 'Board deleted successfully.' });
			}

			const scheduledForDeletion = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

			const deletedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { scheduledForDeletion } });
			if (!deletedBoard) return json(c, 500, { error: 'Failed to delete board.' });

			return json(c, 200, { data: 'Board scheduled for deletion.' });
		},
	}),

	// Ohter board.
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/room',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const accessLevel = getBoardAccessLevel(c.var.DBUser, boardId, categoryId, groupId);
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const typeName = DBBoard.type === 'Excalidraw' ? 'excalidrawSocket' : 'tldrawSocket';

			const RoomData = manager.socket[typeName].roomData.get(boardId);
			if (!RoomData) return json(c, 404, { error: 'Board not found or no one is currently collaborating.' });

			return json(c, 200, {
				data: {
					boardId: RoomData.boardId,
					type: RoomData.boardType,
					elements: 'elements' in RoomData ? RoomData.elements : RoomData.room.getCurrentDocumentClock(),
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
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/room-kick',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const canManage = canManageBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canManage) return json(c, 403, { error: 'You do not have access to this board.' });

			const userId = c.req.query('userId');
			if (!userId) return json(c, 400, { error: 'User ID is required.' });

			const TargetUser = await db(manager, 'user', 'findUnique', { where: { userId }, ...DBUserPartial });
			if (!TargetUser) return json(c, 404, { error: 'User not found.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const typeName = DBBoard.type === 'Excalidraw' ? 'excalidrawSocket' : 'tldrawSocket';

			const RoomData = manager.socket[typeName].roomData.get(boardId);
			if (!RoomData) return json(c, 404, { error: 'Board not found or no one is currently collaborating.' });

			const targetIsSelf = c.var.DBUser.userId === userId;
			if (targetIsSelf) return json(c, 400, { error: 'You cannot kick yourself from the room.' });

			const targetIsDev = isDeveloper(TargetUser.email);
			if (targetIsDev && !c.var.isDev) return json(c, 403, { error: 'You cannot kick a developer.' });

			const resource = { type: 'board' as const, data: { boardId, categoryId, groupId } };
			const currentUserRole = getUserHighestRole(c.var.DBUser, resource);
			const targetUserRole = getUserHighestRole(TargetUser, resource);

			const targetAccessLevel = getBoardAccessLevel(TargetUser, boardId, categoryId, groupId);
			if (!targetAccessLevel) return json(c, 400, { error: 'The target user does not have access to this board.' });

			if (!c.var.isDev) {
				if (!currentUserRole) return json(c, 403, { error: 'Insufficient role to kick users from this board.' });

				const currentRank = PermissionHierarchy[currentUserRole] ?? 0;
				const targetRank = targetUserRole ? (PermissionHierarchy[targetUserRole] ?? 0) : 0;

				if (targetRank >= currentRank) return json(c, 403, { error: 'You cannot kick a user with the same or higher role than you.' });
				if (targetAccessLevel !== 'read' && targetRank === 0) return json(c, 403, { error: 'You cannot kick a user who has more than read access to this board.' });
			}

			const kicked = await manager.socket[typeName].kickUser(boardId, userId);
			if (!kicked) return json(c, 404, { error: 'User not found in the room.' });

			return json(c, 200, { data: `User ${kicked} kicked from the room.` });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/cancel-deletion',
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
