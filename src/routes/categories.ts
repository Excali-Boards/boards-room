import { parseZodError, securityUtils } from '../modules/functions.js';
import { getAccessLevel, canManage } from '../other/permissions.js';
import { json, makeRoute } from '../services/routes.js';
import config, { nameObject } from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/groups/:groupId/categories',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateCategory = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canCreateCategory) return json(c, 403, { error: 'You do not have permission to create categories in this group.' });

			const totalCategories = await db(manager, 'category', 'findMany', { where: { groupId }, select: { index: true } }) || [];
			const newCategory = await db(manager, 'category', 'create', {
				data: {
					name: isValid.data.name,
					categoryId: securityUtils.randomString(12),
					index: (totalCategories && totalCategories.length > 0 ? Math.max(...totalCategories.map((c) => c.index)) + 1 : 0),
					groupId,
				},
			});

			if (!newCategory) return json(c, 500, { error: 'Failed to create category.' });
			return json(c, 200, { data: 'Successfully created category.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid category order.' });

			const canReorderCategories = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canReorderCategories) return json(c, 403, { error: 'You do not have permission to reorder categories in this group.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const DBCategories = await db(manager, 'category', 'findMany', { where: { groupId, categoryId: { in: isValid.data } } }) || [];
			if (DBCategories.length !== isValid.data.length) return json(c, 400, { error: 'Some categories do not belong to this group.' });

			const updatePromises = isValid.data.map((categoryId, index) =>
				db(manager, 'category', 'update', {
					where: { categoryId },
					data: { index },
					select: { categoryId: true },
				}),
			);

			await Promise.all(updatePromises);

			return json(c, 200, { data: 'Categories reordered successfully.' });
		},
	}),

	makeRoute({
		path: '/groups/:groupId/categories/:categoryId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have permission to view this category.' });

			const accessLevelGroup = getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId } });

			const DBCategory = await db(manager, 'category', 'findUnique', {
				where: c.var.isDev ? { categoryId, groupId } : {
					categoryId,
					groupId,
					OR: [
						{ groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } },
						{ categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } },
						{ boards: { some: { boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } } } },
					],
				},
				select: {
					categoryId: true,
					name: true,
					index: true,
					group: { select: { groupId: true, name: true, index: true } },
					boards: {
						where: c.var.isDev ? undefined : {
							OR: [
								{ category: { groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } } },
								{ categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } },
								{ boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } },
							],
						},
						select: {
							boardId: true,
							name: true,
							index: true,
							totalSizeBytes: true,
							scheduledForDeletion: true,
							flashcardDeck: {
								select: {
									deckId: true,
								},
							},
						},
					},
				},
			});

			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			return json(c, 200, {
				data: {
					group: {
						id: DBCategory.group.groupId,
						name: DBCategory.group.name,
						index: DBCategory.group.index,
						accessLevel: accessLevelGroup || 'read',
					},
					category: {
						id: DBCategory.categoryId,
						name: DBCategory.name,
						index: DBCategory.index,
						accessLevel,
					},
					boards: DBCategory.boards.sort((a, b) => a.index - b.index).map((board) => ({
						id: board.boardId,
						name: board.name,
						index: board.index,
						accessLevel: getAccessLevel(c.var.DBUser, { type: 'board', data: { boardId: board.boardId, categoryId, groupId } }) || 'read',
						totalSizeBytes: board.totalSizeBytes,
						hasFlashcards: board.flashcardDeck !== null,
						scheduledForDeletion: board.scheduledForDeletion,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${board.boardId}.bin`,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canUpdateCategory = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canUpdateCategory) return json(c, 403, { error: 'You do not have permission to update this category.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

			const updatedCategory = await db(manager, 'category', 'update', { where: { categoryId, groupId }, data: { name: isValid.data.name } });
			if (!updatedCategory) return json(c, 500, { error: 'Failed to update category.' });

			return json(c, 200, { data: 'Category updated successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const canDeleteCategory = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canDeleteCategory) return json(c, 403, { error: 'You do not have permission to delete this category.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId }, include: { boards: true } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });
			else if (DBCategory.boards.length) return json(c, 400, { error: 'Category has boards.' });

			const deletedCategory = await db(manager, 'category', 'delete', { where: { categoryId, groupId } });
			if (!deletedCategory) return json(c, 500, { error: 'Failed to delete category.' });

			const DBInvites = await db(manager, 'invite', 'findMany', { where: { categoryIds: { has: categoryId } } }) || [];
			await Promise.all(DBInvites.map((inv) => {
				const newCategoryIds = inv.categoryIds.filter((id) => id !== categoryId);

				if (!newCategoryIds.length && !inv.groupIds.length && !inv.boardIds.length) {
					return db(manager, 'invite', 'delete', { where: { dbId: inv.dbId } });
				}

				return db(manager, 'invite', 'update', { where: { dbId: inv.dbId }, data: { categoryIds: newCategoryIds } });
			}));

			return json(c, 200, { data: 'Category deleted successfully.' });
		},
	}),
];
