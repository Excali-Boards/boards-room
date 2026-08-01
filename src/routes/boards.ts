import { isDeveloper, canManage, canManagePermissions, getBoardAccessLevel, getCategoryAccessLevel, getGroupAccessLevel, canManageBoardWithIds, getUserHighestRole, PermissionHierarchy } from '../other/permissions.js';
import { DBUserPartial, PersonalWorkspaceArgs, PersonalWorkspaceType } from '../other/vars.js';
import { compressionUtils, parseZodError, securityUtils } from '../modules/functions.js';
import config, { boardObject, nameObject } from '../core/config.js';
import { db, invalidateCacheForWrite } from '../core/prisma.js';
import { json, makeRoute } from '../services/routes.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/personal',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (config.personalBoardsMode === 'none' && !c.var.isDev) return json(c, 404, { error: 'Personal boards are disabled.' });

			const workspaces = c.var.isDev ? await manager.prisma.personalWorkspace.findMany(PersonalWorkspaceArgs) : null;
			const workspace = c.var.isDev ? null : await manager.prisma.personalWorkspace.findUnique({ where: { userId: c.var.DBUser.userId }, ...PersonalWorkspaceArgs });

			const mapWorkspace = (workspace: PersonalWorkspaceType) => ({
				id: workspace.groupId,
				owner: workspace.user,
				boards: workspace.boards
					.filter(({ categoryId }) => categoryId === null)
					.map(({ board }) => ({ ...board, id: board.boardId })),
				categories: workspace.categories.map((category) => ({
					id: category.backingCategoryId,
					name: category.name,
					boards: category.boards.map(({ board }) => ({
						...board, id: board.boardId, categoryId: category.backingCategoryId,
					})),
				})),
			});

			return json(c, 200, {
				data: c.var.isDev ? {
					owners: workspaces?.map(mapWorkspace) || [],
				} : (workspace ? mapWorkspace(workspace) : null),
			});
		},
	}),
	makeRoute({
		path: '/personal',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const canCreatePersonal = config.personalBoardsMode === 'anyone' || (config.personalBoardsMode === 'devs' && c.var.isDev);
			if (!canCreatePersonal) return json(c, 403, { error: 'You do not have permission to create personal boards.' });

			const isValid = boardObject.extend({ categoryId: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const boardId = securityUtils.randomString(12);
			const created = await manager.prisma.$transaction(async (tx) => {
				let workspace = await tx.personalWorkspace.findUnique({ where: { userId: c.var.DBUser.userId }, select: { dbId: true, groupId: true, categories: { select: { dbId: true, categoryId: true, backingCategoryId: true } }, group: { select: { categories: { select: { categoryId: true } } } } } });
				if (!workspace) {
					const groupId = securityUtils.randomString(12); const backingCategoryId = securityUtils.randomString(12);
					const groupIndex = await tx.group.aggregate({ _max: { index: true } });

					await tx.group.create({ data: { groupId, name: 'Personal Boards', index: (groupIndex._max.index ?? -1) + 1, permissions: { create: { userId: c.var.DBUser.userId, role: 'GroupAdmin', grantedBy: c.var.DBUser.userId } }, categories: { create: { categoryId: backingCategoryId, name: 'Personal storage', index: 0 } } } });
					workspace = await tx.personalWorkspace.create({ select: { dbId: true, groupId: true, categories: { select: { dbId: true, categoryId: true, backingCategoryId: true } }, group: { select: { categories: { select: { categoryId: true } } } } }, data: { userId: c.var.DBUser.userId, groupId } });
				}

				const selected = isValid.data.categoryId ? workspace.categories.find((category) => category.categoryId === isValid.data.categoryId || category.backingCategoryId === isValid.data.categoryId) : undefined;
				if (isValid.data.categoryId && !selected) throw new Error('Personal category not found.');

				const backingCategoryId = selected?.backingCategoryId || workspace.categories.find((category) => category.backingCategoryId)?.backingCategoryId || workspace.group.categories.find((category) => category.categoryId)?.categoryId;
				if (!backingCategoryId) throw new Error('Personal backing category not found.');

				const boardIndex = await tx.board.aggregate({ where: { categoryId: backingCategoryId }, _max: { index: true } });

				await tx.board.create({ data: { boardId, name: isValid.data.name, type: isValid.data.type, categoryId: backingCategoryId, index: (boardIndex._max.index ?? -1) + 1 } });
				await tx.personalBoard.create({ data: { boardId, workspaceId: workspace.dbId, categoryId: selected?.dbId || null } });

				return { groupId: workspace.groupId, categoryId: selected?.backingCategoryId || backingCategoryId, boardId };
			});

			const uploaded = await manager.files.uploadBoardFile(boardId, compressionUtils.compressAndEncrypt(isValid.data.type === 'Excalidraw' ? [] : {}), 'application/octet-stream').catch(() => null);
			if (!uploaded) { await manager.prisma.board.deleteMany({ where: { boardId } }).catch(() => null); return json(c, 500, { error: 'Failed to initialize personal board.' }); }

			return json(c, 200, { data: created });
		},
	}),
	makeRoute({
		path: '/personal/categories',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const canCreatePersonal = config.personalBoardsMode === 'anyone' || (config.personalBoardsMode === 'devs' && c.var.isDev);
			if (!canCreatePersonal) return json(c, 403, { error: 'You do not have permission to create personal categories.' });

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const category = await manager.prisma.$transaction(async (tx) => {
				const workspace = await tx.personalWorkspace.findUnique({ where: { userId: c.var.DBUser.userId }, select: { dbId: true, groupId: true } });
				if (!workspace) throw new Error('Create a personal board before creating a category.');

				const backingCategoryId = securityUtils.randomString(12); const categoryId = securityUtils.randomString(12);
				const max = await tx.category.aggregate({ where: { groupId: workspace.groupId }, _max: { index: true } });
				await tx.category.create({ data: { categoryId: backingCategoryId, name: isValid.data.name, groupId: workspace.groupId, index: (max._max.index ?? -1) + 1 } });

				const personalMax = await tx.personalCategory.aggregate({ where: { workspaceId: workspace.dbId }, _max: { index: true } });
				return tx.personalCategory.create({ select: { categoryId: true, name: true, backingCategoryId: true }, data: { categoryId, name: isValid.data.name, index: (personalMax._max.index ?? -1) + 1, workspaceId: workspace.dbId, backingCategoryId } });
			});

			return json(c, 200, { data: category });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const createBoardSchema = boardObject.extend({
				copyPermissionsFromBoardId: z.string().optional(),
			});

			const isValid = createBoardSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateBoard = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canCreateBoard) return json(c, 403, { error: 'You do not have permission to create boards in this category.' });

			if (isValid.data.copyPermissionsFromBoardId) {
				const sourceBoard = await db(manager, 'board', 'findUnique', {
					where: { boardId: isValid.data.copyPermissionsFromBoardId },
					select: { boardId: true, categoryId: true, category: { select: { groupId: true } } },
				});

				if (!sourceBoard) return json(c, 400, { error: 'Source board for permission copy not found.' });
				if (!canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId, groupId } }) || !canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId: sourceBoard.boardId, categoryId: sourceBoard.categoryId, groupId: sourceBoard.category.groupId } })) {
					return json(c, 403, { error: 'You do not have permission to copy this board\'s permissions.' });
				}
			}

			const totalBoards = await db(manager, 'board', 'findMany', { where: { categoryId, category: { groupId } }, select: { index: true } });
			const newBoardId = securityUtils.randomString(12);
			const newBoard = await db(manager, 'board', 'create', {
				data: {
					name: isValid.data.name,
					type: isValid.data.type,
					categoryId,
					boardId: newBoardId,
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

			if (isValid.data.copyPermissionsFromBoardId) {
				const sourcePerms = await db(manager, 'boardPermission', 'findMany', {
					where: { boardId: isValid.data.copyPermissionsFromBoardId },
					select: { userId: true, role: true },
				}) || [];

				if (sourcePerms.length > 0) {
					await db(manager, 'boardPermission', 'createMany', {
						data: sourcePerms.map((perm) => ({
							userId: perm.userId,
							boardId: newBoardId,
							role: perm.role,
							grantedBy: c.var.DBUser.userId,
						})),
					});
				}
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
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/move',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const groupId = c.req.param('groupId');
			const categoryId = c.req.param('categoryId');

			const isValid = moveBoardSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } }, select: { boardId: true, categoryId: true, index: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });
			if (!canManageBoardWithIds(c.var.DBUser, boardId, categoryId, groupId)) return json(c, 403, { error: 'You do not have permission to move this board.' });

			const DBTargetCategory = await db(manager, 'category', 'findUnique', { where: { categoryId: isValid.data.targetCategoryId }, select: { categoryId: true, groupId: true, group: { select: { personalWorkspace: { select: { dbId: true } } } } } });
			if (!DBTargetCategory) return json(c, 404, { error: 'Target category not found.' });
			if (DBTargetCategory.group.personalWorkspace) return json(c, 403, { error: 'Boards cannot be moved into personal boards.' });
			if (!canManage(c.var.DBUser, { type: 'category', data: { categoryId: DBTargetCategory.categoryId, groupId: DBTargetCategory.groupId } })) return json(c, 403, { error: 'You do not have permission to move boards into this category.' });

			if (DBBoard.categoryId === DBTargetCategory.categoryId) return json(c, 400, { error: 'Source and target category cannot be the same.' });

			const movedBoard = await manager.prisma.$transaction(async (tx) => {
				const sourceCategoryId = DBBoard.categoryId;
				const targetCategoryId = DBTargetCategory.categoryId;

				await tx.board.updateMany({
					where: {
						categoryId: sourceCategoryId,
						index: { gt: DBBoard.index },
					},
					data: { index: { decrement: 1 } },
				});

				const targetCount = await tx.board.count({
					where: { categoryId: targetCategoryId },
				});

				const desiredIndex = isValid.data.targetIndex ?? targetCount;
				const newIndex = Math.max(0, Math.min(desiredIndex, targetCount));

				await tx.board.updateMany({
					where: {
						categoryId: targetCategoryId,
						index: { gte: newIndex },
					},
					data: { index: { increment: 1 } },
				});

				return tx.board.update({
					where: { boardId },
					data: {
						categoryId: targetCategoryId,
						index: newIndex,
					},
					select: { boardId: true, categoryId: true, index: true },
				});
			});
			await manager.prisma.personalBoard.deleteMany({ where: { boardId } });

			await Promise.all([
				invalidateCacheForWrite(manager, 'board'),
				invalidateCacheForWrite(manager, 'category'),
			]);

			return json(c, 200, {
				data: {
					boardId: movedBoard.boardId,
					categoryId: movedBoard.categoryId,
					groupId: DBTargetCategory.groupId,
					index: movedBoard.index,
				},
			});
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

				await Promise.all([
					invalidateCacheForWrite(manager, 'board'),
					invalidateCacheForWrite(manager, 'category'),
				]);

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

// Schemas.
const moveBoardSchema = z.object({
	targetCategoryId: z.string().min(1),
	targetIndex: z.number().int().min(0).optional(),
});
