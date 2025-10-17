import { parseZodError, securityUtils } from '../modules/functions.js';
import { canManage, getAccessLevel } from '../other/permissions.js';
import { json, makeRoute } from '../services/routes.js';
import { nameObject } from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	// Groups.
	makeRoute({
		path: '/groups',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const DBGroups = await db(manager, 'group', 'findMany', {
				where: c.var.isDev ? undefined : {
					OR: [
						{ groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } },
						{ categories: { some: { categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } } } },
						{ categories: { some: { boards: { some: { boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } } } } } },
					],
				},
				select: {
					groupId: true,
					name: true,
					index: true,
					categories: {
						where: c.var.isDev ? undefined : {
							OR: [
								{ groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } },
								{ categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } },
								{ boards: { some: { boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } } } },
							],
						},
						select: {
							categoryId: true,
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
									totalSizeBytes: true,
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, {
				data: DBGroups.sort((a, b) => a.index - b.index).map((g) => ({
					id: g.groupId,
					name: g.name,
					index: g.index,
					categories: g.categories.length,
					isDefault: c.var.DBUser.mainGroupId === g.groupId,
					accessLevel: getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId: g.groupId } }) || 'read',
					sizeBytes: g.categories.reduce((acc, cat) => acc + cat.boards.reduce((boardAcc, board) => boardAcc + (board.totalSizeBytes || 0), 0), 0) || 0,
				})),
			});
		},
	}),
	makeRoute({
		path: '/groups',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateGroup = canManage(c.var.DBUser, { type: 'global', data: null });
			if (!canCreateGroup) return json(c, 403, { error: 'You do not have permission to create groups.' });

			const totalGroups = await db(manager, 'group', 'findMany', { select: { index: true } }) || [];
			const newGroup = await db(manager, 'group', 'create', {
				select: { groupId: true },
				data: {
					name: isValid.data.name,
					groupId: securityUtils.randomString(12),
					categories: { create: [] },
					index: (totalGroups && totalGroups.length > 0 ? Math.max(...totalGroups.map((g) => g.index)) + 1 : 0),
				},
			});

			if (!newGroup) return json(c, 500, { error: 'Failed to create group.' });
			return json(c, 200, { data: 'Group created successfully.' });
		},
	}),
	makeRoute({
		path: '/groups',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid group order.' });

			const canReorderGroups = canManage(c.var.DBUser, { type: 'global', data: null });
			if (!canReorderGroups) return json(c, 403, { error: 'You do not have permission to reorder groups.' });

			const DBGroups = await db(manager, 'group', 'findMany', { where: { groupId: { in: isValid.data } } }) || [];
			if (DBGroups.length !== isValid.data.length) return json(c, 400, { error: 'Some groups do not exist.' });

			const updatePromises = isValid.data.map((groupId, index) =>
				db(manager, 'group', 'update', {
					where: { groupId },
					data: { index },
					select: { groupId: true },
				}),
			);

			await Promise.all(updatePromises);

			return json(c, 200, { data: 'Groups reordered successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have permission to view this group.' });

			const DBGroup = await db(manager, 'group', 'findUnique', {
				where: c.var.isDev ? { groupId } : {
					groupId,
					OR: [
						{ groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } },
						{ categories: { some: { categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } } } },
						{ categories: { some: { boards: { some: { boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } } } } } },
					],
				},
				select: {
					groupId: true,
					name: true,
					index: true,
					events: {
						select: { eventId: true },
					},
					categories: {
						where: c.var.isDev ? undefined : {
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
							boards: {
								where: c.var.isDev ? undefined : {
									OR: [
										{ category: { groupId: { in: c.var.DBUser.groupPermissions.map((g) => g.groupId) || [] } } },
										{ categoryId: { in: c.var.DBUser.categoryPermissions.map((ca) => ca.categoryId) || [] } },
										{ boardId: { in: c.var.DBUser.boardPermissions.map((b) => b.boardId) || [] } },
									],
								},
								select: { boardId: true, totalSizeBytes: true },
							},
						},
					},
				},
			});

			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			return json(c, 200, {
				data: {
					group: {
						id: DBGroup.groupId,
						name: DBGroup.name,
						index: DBGroup.index,
						accessLevel,
					},
					categories: DBGroup.categories.sort((a, b) => a.index - b.index).map((cat) => ({
						id: cat.categoryId,
						name: cat.name,
						index: cat.index,
						boards: cat.boards.length,
						accessLevel: getAccessLevel(c.var.DBUser, { type: 'category', data: { categoryId: cat.categoryId, groupId } }) || 'read',
						totalSizeBytes: cat.boards.reduce((acc, board) => acc + board.totalSizeBytes, 0) || 0,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/groups/:groupId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canEditGroup = canManage(c.var.DBUser, { type: 'global', data: null });
			if (!canEditGroup) return json(c, 403, { error: 'You do not have permission to edit groups.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const updatedGroup = await db(manager, 'group', 'update', { where: { groupId }, data: { name: isValid.data.name }, select: { groupId: true } });
			if (!updatedGroup) return json(c, 500, { error: 'Failed to update group.' });

			return json(c, 200, { data: 'Group updated successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const canDeleteGroup = canManage(c.var.DBUser, { type: 'global', data: null });
			if (!canDeleteGroup) return json(c, 403, { error: 'You do not have permission to delete groups.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId }, include: { categories: true } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });
			else if (DBGroup.categories.length) return json(c, 400, { error: 'Group has categories.' });

			const deletedGroup = await db(manager, 'group', 'delete', { where: { groupId } });
			if (!deletedGroup) return json(c, 500, { error: 'Failed to delete group.' });

			const DBInvites = await db(manager, 'invite', 'findMany', { where: { groupIds: { has: groupId } } }) || [];
			await Promise.all(DBInvites.map((inv) => {
				const newGroupIds = inv.groupIds.filter((id) => id !== groupId);

				if (!newGroupIds.length && !inv.categoryIds.length && !inv.boardIds.length) {
					return db(manager, 'invite', 'delete', { where: { dbId: inv.dbId } });
				}

				return db(manager, 'invite', 'update', { where: { dbId: inv.dbId }, data: { groupIds: newGroupIds } });
			}));

			return json(c, 200, { data: 'Group deleted successfully.' });
		},
	}),
];
