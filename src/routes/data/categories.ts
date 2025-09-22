import { parseZodError, securityUtils } from '../../modules/functions';
import { getAccessLevel, canManage } from '../../other/permissions';
import { json, makeRoute } from '../../services/routes';
import config, { nameObject } from '../../core/config';
import { db } from '../../core/prisma';
import manager from '../../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/data/groups/:groupId/categories',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateCategory = await canManage(c.var.DBUser, { type: 'group', data: { groupId } });
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
		path: '/data/groups/:groupId/categories',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid category order.' });

			const canReorderCategories = await canManage(c.var.DBUser, { type: 'group', data: { groupId } });
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
		path: '/data/groups/:groupId/categories/:categoryId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const accessLevel = await getAccessLevel(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have permission to view this category.' });

			const accessLevelGroup = await getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId } });

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
						},
					},
				},
			});

			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });
			else if (!DBCategory.boards.length && !c.var.isDev) return json(c, 403, { error: 'You do not have access to any boards in this category.' });

			const boardAccessLevels = await Promise.all(
				DBCategory.boards.map(async (board) => ({
					boardId: board.boardId,
					accessLevel: await getAccessLevel(c.var.DBUser, { type: 'board', data: { boardId: board.boardId, categoryId, groupId } }) || 'read',
				})),
			);

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
						accessLevel: boardAccessLevels.find((bal) => bal.boardId === board.boardId)?.accessLevel || 'read',
						totalSizeBytes: board.totalSizeBytes,
						scheduledForDeletion: board.scheduledForDeletion,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${board.boardId}.bin`,
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

			const canUpdateCategory = await canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canUpdateCategory) return json(c, 403, { error: 'You do not have permission to update this category.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });

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

			const canDeleteCategory = await canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canDeleteCategory) return json(c, 403, { error: 'You do not have permission to delete this category.' });

			const DBCategory = await db(manager, 'category', 'findUnique', { where: { categoryId, groupId }, include: { boards: true } });
			if (!DBCategory) return json(c, 404, { error: 'Category not found.' });
			else if (DBCategory.boards.length) return json(c, 400, { error: 'Category has boards.' });

			const deletedCategory = await db(manager, 'category', 'delete', { where: { categoryId, groupId } });
			if (!deletedCategory) return json(c, 500, { error: 'Failed to delete category.' });

			return json(c, 200, { data: 'Category deleted successfully.' });
		},
	}),
];
