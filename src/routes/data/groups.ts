import { parseZodError, securityUtils } from '../../modules/utils';
import config, { nameObject } from '../../modules/config';
import { json, makeRoute } from '../../classes/routes';
import { db } from '../../modules/prisma';
import manager from '../../index';
import { z } from 'zod';

export default [
	// Groups.
	makeRoute({
		path: '/data/groups',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const DBGroups = await db(manager, 'group', 'findMany', {
				include: { categories: { include: { boards: true } } },
				where: c.var.privileged ? undefined : {
					categories: {
						some: {
							boards: {
								some: {
									boardId: {
										in: [
											...c.var.DBUser.boardPermissions.map((p) => p.boardId),
											...c.var.DBUser.ownedBoards.map((b) => b.boardId),
										],
									},
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					groups: DBGroups.sort((a, b) => a.index - b.index).map((g) => ({
						id: g.groupId,
						name: g.name,
						index: g.index,
						categories: g.categories.length,
						isDefault: c.var.DBUser.mainGroupId === g.groupId,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/data/groups',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to create groups.' });

			const existingGroup = await db(manager, 'group', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name } } });
			if (existingGroup) return json(c, 400, { error: 'Group with that name already exists.' });

			const totalGroups = await db(manager, 'group', 'count', {}) || 0;
			const newGroup = await db(manager, 'group', 'create', {
				select: { groupId: true },
				data: {
					name: isValid.data.name,
					groupId: securityUtils.randomString(12),
					categories: { create: [] },
					index: totalGroups,
				},
			});

			if (!newGroup) return json(c, 500, { error: 'Failed to create group.' });
			return json(c, 200, { data: 'Group created successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to reorder groups.' });

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid group order.' });

			const DBGroups = await db(manager, 'group', 'findMany', { where: { groupId: { in: isValid.data } }, orderBy: { index: 'asc' } }) || [];
			if (DBGroups.length !== isValid.data.length) return json(c, 400, { error: 'Some groups do not exist.' });

			for (let i = 0; i < DBGroups.length; i++) {
				await db(manager, 'group', 'update', {
					where: { groupId: DBGroups[i]?.groupId },
					data: { index: i },
					select: { groupId: true },
				});
			}

			return json(c, 200, { data: 'Groups reordered successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId }, include: { categories: { include: { boards: true } } } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const boardIds = c.var.privileged ? null : c.var.DBUser.boardPermissions.map((p) => p.boardId);
			const allowedCategories = c.var.privileged
				? DBGroup.categories
				: DBGroup.categories.filter((cat) =>
					cat.boards.some((board) =>
						boardIds?.includes(board.boardId) ||
						c.var.DBUser.ownedBoards.some((b) => b.boardId === board.boardId),
					),
				);

			if (!allowedCategories.length && !c.var.privileged) return json(c, 403, { error: 'You do not have access to any categories in this group.' });

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					group: {
						id: DBGroup.groupId,
						name: DBGroup.name,
						index: DBGroup.index,
					},
					categories: allowedCategories.sort((a, b) => a.index - b.index).map((cat) => ({
						id: cat.categoryId,
						name: cat.name,
						index: cat.index,
						boards: cat.boards.length,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to update groups.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const existingGroup = await db(manager, 'group', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name }, groupId: { not: groupId } } });
			if (existingGroup) return json(c, 400, { error: 'Group with that name already exists.' });

			const updatedGroup = await db(manager, 'group', 'update', { where: { groupId }, data: { name: isValid.data.name }, select: { groupId: true } });
			if (!updatedGroup) return json(c, 500, { error: 'Failed to update group.' });

			return json(c, 200, { data: 'Group updated successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');
			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to delete groups.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId }, include: { categories: true } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });
			else if (DBGroup.categories.length) return json(c, 400, { error: 'Group has categories.' });

			const deletedGroup = await db(manager, 'group', 'delete', { where: { groupId } });
			if (!deletedGroup) return json(c, 500, { error: 'Failed to delete group.' });

			return json(c, 200, { data: 'Group deleted successfully.' });
		},
	}),

	// Categories.
	makeRoute({
		path: '/data/groups/:groupId/categories',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to create categories.' });

			const existingCategory = await db(manager, 'category', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name }, groupId } });
			if (existingCategory) return json(c, 400, { error: 'Category with that name already exists in this group.' });

			const totalCategories = await db(manager, 'category', 'count', { where: { groupId } }) || 0;
			const newCategory = await db(manager, 'category', 'create', {
				data: {
					name: isValid.data.name,
					categoryId: securityUtils.randomString(12),
					index: totalCategories,
					groupId,
				},
			});

			if (!newCategory) return json(c, 500, { error: 'Failed to create category.' });
			return json(c, 200, { data: 'Successfully created category.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');
			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to reorder categories.' });

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid category order.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const DBCategories = await db(manager, 'category', 'findMany', { where: { groupId, categoryId: { in: isValid.data } }, orderBy: { index: 'asc' } }) || [];
			if (DBCategories.length !== isValid.data.length) return json(c, 400, { error: 'Some categories do not belong to this group.' });

			for (let i = 0; i < DBCategories.length; i++) {
				await db(manager, 'category', 'update', {
					where: { categoryId: DBCategories[i]?.categoryId },
					data: { index: i },
					select: { categoryId: true },
				});
			}

			return json(c, 200, { data: 'Categories reordered successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId }, include: { group: true, boards: true } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			const boardIds = c.var.privileged ? null : c.var.DBUser.boardPermissions.map((p) => p.boardId);
			const allowedBoards = c.var.privileged
				? DBCategory.boards
				: DBCategory.boards.filter((board) =>
					boardIds?.includes(board.boardId) ||
					c.var.DBUser.ownedBoards.some((b) => b.boardId === board.boardId),
				);

			if (!allowedBoards.length && !c.var.privileged) return json(c, 403, { error: 'You do not have access to any boards in this category.' });

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					group: {
						id: DBCategory.group.groupId,
						name: DBCategory.group.name,
						index: DBCategory.group.index,
					},
					category: {
						id: DBCategory.categoryId,
						name: DBCategory.name,
						index: DBCategory.index,
					},
					boards: allowedBoards.sort((a, b) => a.index - b.index).map((board) => ({
						id: board.boardId,
						name: board.name,
						index: board.index,
						boardId: board.boardId,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to update categories.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			const existingCategory = await db(manager, 'category', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name }, categoryId: { not: categoryId } } });
			if (existingCategory) return json(c, 400, { error: 'Category with that name already exists.' });

			const updatedCategory = await db(manager, 'category', 'update', { where: { categoryId, groupId }, data: { name: isValid.data.name } });
			if (!updatedCategory) return json(c, 500, { error: 'Failed to update category.' });

			return json(c, 200, { data: 'Category updated successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to delete categories.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId }, include: { boards: true } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });
			else if (DBCategory.boards.length) return json(c, 400, { error: 'Category has boards.' });

			const deletedCategory = await db(manager, 'category', 'delete', { where: { categoryId, groupId } });
			if (!deletedCategory) return json(c, 500, { error: 'Failed to delete category.' });

			return json(c, 200, { data: 'Category deleted successfully.' });
		},
	}),

	// Boards.
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
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to create boards.' });

			const existingBoard = await db(manager, 'board', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name }, categoryId, groupId } });
			if (existingBoard) return json(c, 400, { error: 'Board with that name already exists in this category.' });

			const totalBoards = await db(manager, 'board', 'count', { where: { categoryId, groupId } }) || 0;
			const newBoard = await db(manager, 'board', 'create', {
				data: {
					name: isValid.data.name,
					boardId: securityUtils.randomString(12),
					categoryId,
					index: totalBoards,
					ownerId: c.var.DBUser.userId,
				},
			});

			if (!newBoard) return json(c, 500, { error: 'Failed to create board.' });
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

			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to reorder boards.' });

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid board order.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			const DBBoards = await db(manager, 'board', 'findMany', { where: { categoryId, groupId, boardId: { in: isValid.data } }, orderBy: { index: 'asc' } }) || [];
			if (DBBoards.length !== isValid.data.length) return json(c, 400, { error: 'Some boards do not belong to this category.' });

			for (let i = 0; i < DBBoards.length; i++) {
				await db(manager, 'board', 'update', {
					where: { boardId: DBBoards[i]?.boardId },
					data: { index: i },
					select: { boardId: true },
				});
			}

			return json(c, 200, { data: 'Boards reordered successfully.' });
		},
	}),
	makeRoute({
		path: '/data/groups/:groupId/categories/:categoryId/boards',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const DBBoards = await db(manager, 'board', 'findMany', {
				select: {
					boardId: true,
					name: true,
					index: true,
					files: {
						select: {
							fileId: true,
							mimeType: true,
							createdAt: true,
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
				where: c.var.privileged ? { categoryId, category: { groupId } } : {
					categoryId,
					category: { groupId },
					boardId: {
						in: [
							...c.var.DBUser.boardPermissions.map((p) => p.boardId),
							...c.var.DBUser.ownedBoards.map((b) => b.boardId),
						],
					},
				},
			}) || [];

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					boards: DBBoards.map((board) => ({
						group: {
							id: board.category.group.groupId,
							name: board.category.group.name,
							index: board.category.group.index,
						},
						category: {
							id: board.category.categoryId,
							name: board.category.name,
							index: board.category.index,
						},
						board: {
							id: board.boardId,
							name: board.name,
							index: board.index,
							dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${board.boardId}.bin`,
							accessLevel: c.var.privileged || c.var.DBUser.ownedBoards.some((b) => b.boardId === board.boardId)
								? 'Write'
								: c.var.DBUser.boardPermissions.find((p) => p.boardId === board.boardId)?.permissionType || 'Read',
							files: board.files.map((file) => ({
								fileId: file.fileId,
								mimeType: file.mimeType,
								createdAt: file.createdAt,
								fileUrl: `${config.s3.endpoint}/${config.s3.bucket}/${board.boardId}/${file.fileId}`,
							})),
						},
					})),
				},
			});
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

			const boardPerm = c.var.DBUser.boardPermissions.find((p) => p.boardId === boardId);
			const isOwner = c.var.DBUser.ownedBoards.some((b) => b.boardId === boardId);

			const canManage = c.var.privileged || isOwner || boardPerm?.permissionType === 'Write';
			const canRead = c.var.privileged || isOwner || !!boardPerm || canManage;
			if (!canRead) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } }, include: { category: { include: { group: true } }, files: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					group: {
						id: DBBoard.category.group.groupId,
						name: DBBoard.category.group.name,
						index: DBBoard.category.group.index,
					},
					category: {
						id: DBBoard.category.categoryId,
						name: DBBoard.category.name,
						index: DBBoard.category.index,
					},
					board: {
						id: DBBoard.boardId,
						name: DBBoard.name,
						index: DBBoard.index,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${DBBoard.boardId}.bin`,
						accessLevel: boardPerm?.permissionType || (isOwner ? 'Write' : 'Read'),
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
			else if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to update boards.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const existingBoard = await db(manager, 'board', 'findFirst', { where: { name: { mode: 'insensitive', equals: isValid.data.name }, boardId: { not: boardId } } });
			if (existingBoard) return json(c, 400, { error: 'Board with that name already exists.' });

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

			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to delete boards.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const deletedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { scheduledForDeletion: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) } });
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

			const boardPerm = c.var.DBUser.boardPermissions.find((p) => p.boardId === boardId);
			const isOwner = c.var.DBUser.ownedBoards.some((b) => b.boardId === boardId);

			const canManage = c.var.privileged || isOwner || boardPerm?.permissionType === 'Write';
			const canRead = c.var.privileged || isOwner || !!boardPerm || canManage;
			if (!canRead) return json(c, 403, { error: 'You do not have access to this board.' });

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

			const boardPerm = c.var.DBUser.boardPermissions.find((p) => p.boardId === boardId);
			const isOwner = c.var.DBUser.ownedBoards.some((b) => b.boardId === boardId);

			const canManage = c.var.privileged || isOwner || boardPerm?.permissionType === 'Write';
			if (!canManage) return json(c, 403, { error: 'You do not have access to this board.' });

			const userId = c.req.query('userId');
			if (!userId) return json(c, 400, { error: 'User ID is required.' });

			const TargetUser = await db(manager, 'user', 'findUnique', { where: { userId }, include: { boardPermissions: true, ownedBoards: true } });
			if (!TargetUser) return json(c, 404, { error: 'User not found.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const RoomData = manager.socket.roomData.get(boardId);
			if (!RoomData) return json(c, 404, { error: 'Board not found or no one is currently collaborating.' });

			const targetBoardPerm = TargetUser.boardPermissions.find((p) => p.boardId === boardId);
			const targetIsDev = config.developers.includes(securityUtils.decrypt(TargetUser.email));

			if (!c.var.isDev) {
				if (targetIsDev) return json(c, 403, { error: 'You cannot kick a developer.' });

				const isTargetWrite = TargetUser.isBoardsAdmin || targetBoardPerm?.permissionType === 'Write' || TargetUser.ownedBoards.some((b) => b.boardId === boardId);
				if (c.var.privileged && isTargetWrite) return json(c, 403, { error: 'You can only kick users with read-only access.' });
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

			if (!c.var.privileged) return json(c, 403, { error: 'You do not have permission to cancel deletion of boards.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId, categoryId, category: { groupId } } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const updatedBoard = await db(manager, 'board', 'update', { where: { boardId, categoryId, category: { groupId } }, data: { scheduledForDeletion: null } });
			if (!updatedBoard) return json(c, 500, { error: 'Failed to cancel deletion of board.' });

			return json(c, 200, { data: 'Successfully cancelled deletion of board.' });
		},
	}),
];
