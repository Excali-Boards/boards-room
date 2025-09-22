import { processPermissionGrants, applyPermissionGrants, canManagePermissions } from '../other/permissions';
import { BoardRole, CategoryRole, GroupRole } from '@prisma/client';
import { addPermission, parseZodError } from '../modules/functions';
import { GetBatchResult } from '@prisma/client/runtime/library';
import { GrantedEntry, ResourceType } from '../types';
import { json, makeRoute } from '../services/routes';
import { db } from '../core/prisma';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/permissions/view',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const resourceType = c.req.query('type') as ResourceType;
			if (!resourceType) return json(c, 400, { error: 'Invalid or missing resource type. Must be one of: group, category, board.' });

			const resourceId = c.req.query('id')!;
			if (!resourceId) return json(c, 400, { error: 'Missing resource ID.' });

			const usersWithAccess: Map<string, GrantedEntry[]> = new Map();

			switch (resourceType) {
				case 'board': {
					const board = await db(manager, 'board', 'findUnique', {
						where: { boardId: resourceId },
						select: {
							boardId: true,
							category: { select: { categoryId: true, group: { select: { groupId: true } } } },
						},
					});

					if (!board) return json(c, 404, { error: 'Board not found.' });

					const categoryId = board.category.categoryId;
					const groupId = board.category.group.groupId;

					const canView = await canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId: board.boardId, categoryId, groupId } });
					if (!canView) return json(c, 403, { error: 'No permission' });

					const [boardPerms, categoryPerms, groupPerms] = await Promise.all([
						db(manager, 'boardPermission', 'findMany', { where: { boardId: board.boardId }, select: { userId: true, role: true } }),
						db(manager, 'categoryPermission', 'findMany', { where: { categoryId }, select: { userId: true, role: true } }),
						db(manager, 'groupPermission', 'findMany', { where: { groupId }, select: { userId: true, role: true } }),
					]);

					for (const perm of boardPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'board', role: perm.role, resourceId: board.boardId,
							basedOnType: 'board', basedOnResourceId: board.boardId,
						});
					}

					for (const perm of categoryPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'board', role: perm.role, resourceId: board.boardId,
							basedOnType: 'category', basedOnResourceId: categoryId,
						});
					}

					for (const perm of groupPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'board', role: perm.role, resourceId: board.boardId,
							basedOnType: 'group', basedOnResourceId: groupId,
						});
					}

					break;
				}
				case 'category': {
					const category = await db(manager, 'category', 'findUnique', { where: { categoryId: resourceId }, select: { categoryId: true, group: { select: { groupId: true } } } });
					if (!category) return json(c, 404, { error: 'Category not found.' });

					const groupId = category.group.groupId;

					const canView = await canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId: category.categoryId, groupId } });
					if (!canView) return json(c, 403, { error: 'No permission' });

					const [categoryPerms, groupPerms] = await Promise.all([
						db(manager, 'categoryPermission', 'findMany', { where: { categoryId: category.categoryId }, select: { userId: true, role: true } }),
						db(manager, 'groupPermission', 'findMany', { where: { groupId }, select: { userId: true, role: true } }),
					]);

					for (const perm of categoryPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'category', role: perm.role, resourceId: category.categoryId,
							basedOnType: 'category', basedOnResourceId: category.categoryId,
						});
					}

					for (const perm of groupPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'category', role: perm.role, resourceId: category.categoryId,
							basedOnType: 'group', basedOnResourceId: groupId,
						});
					}

					break;
				}
				case 'group': {
					const group = await db(manager, 'group', 'findUnique', { where: { groupId: resourceId }, select: { groupId: true } });
					if (!group) return json(c, 404, { error: 'Group not found' });

					const canView = await canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId: group.groupId } });
					if (!canView) return json(c, 403, { error: 'No permission' });

					const groupPerms = await db(manager, 'groupPermission', 'findMany', {
						where: { groupId: group.groupId }, select: { userId: true, role: true },
					});

					for (const perm of groupPerms || []) {
						addPermission(usersWithAccess, perm.userId, {
							type: 'group', role: perm.role, resourceId: group.groupId,
							basedOnType: 'group', basedOnResourceId: group.groupId,
						});
					}

					break;
				}
			}

			const userIds = Array.from(usersWithAccess.keys());
			const users = userIds.length
				? (await db(manager, 'user', 'findMany', {
					where: { userId: { in: userIds } },
					select: { userId: true, email: true, displayName: true, avatarUrl: true },
				})) || []
				: [];

			const result = users.map((user) => ({
				...user,
				permissions: usersWithAccess.get(user.userId) || [],
			}));

			return json(c, 200, { data: result });
		},
	}),
	makeRoute({
		path: '/permissions/grant',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const parsed = grantPermissionSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return json(c, 400, { error: parseZodError(parsed.error) });

			const { userId, groupIds, categoryIds, boardIds, groupRole, categoryRole, boardRole } = parsed.data;

			const targetUser = await db(manager, 'user', 'findUnique', { where: { userId } });
			if (!targetUser) return json(c, 404, { error: 'User not found.' });

			if (!c.var.isDev) {
				let canManage = true;

				if (groupIds && groupIds.length > 0) {
					for (const groupId of groupIds) {
						canManage = await canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this group (ID: ${groupId}).` });
					}
				}

				if (categoryIds && categoryIds.length > 0 && canManage) {
					const DBCategories = await db(manager, 'category', 'findMany', { where: { categoryId: { in: categoryIds } }, select: { groupId: true, categoryId: true } }) || [];
					if (DBCategories.length !== categoryIds.length) return json(c, 400, { error: 'Some categories do not exist.' });

					for (const categoryId of categoryIds) {
						const groupId = DBCategories.find((c) => c.categoryId === categoryId)?.groupId;
						if (!groupId) return json(c, 400, { error: `Category (ID: ${categoryId}) does not belong to a valid group.` });

						canManage = await canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this category (ID: ${categoryId}).` });
					}
				}

				if (boardIds && boardIds.length > 0 && canManage) {
					const DBBoards = await db(manager, 'board', 'findMany', { where: { boardId: { in: boardIds } }, select: { category: { select: { groupId: true, categoryId: true } }, boardId: true } }) || [];
					if (DBBoards.length !== boardIds.length) return json(c, 400, { error: 'Some boards do not exist.' });

					for (const boardId of boardIds) {
						const groupId = DBBoards.find((b) => b.boardId === boardId)?.category?.groupId;
						if (!groupId) return json(c, 400, { error: `Board (ID: ${boardId}) does not belong to a valid group.` });

						const categoryId = DBBoards.find((b) => b.boardId === boardId)?.category?.categoryId;
						if (!categoryId) return json(c, 400, { error: `Board (ID: ${boardId}) does not belong to a valid category.` });

						canManage = await canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId, groupId, categoryId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this board (ID: ${boardId}).` });
					}
				}
			}

			const permissionResult = await processPermissionGrants(manager, { userId, groupIds, categoryIds, boardIds, groupRole, categoryRole, boardRole });
			await applyPermissionGrants(manager, permissionResult, c.var.DBUser.userId, userId);

			return json(c, 200, { data: 'Permissions processed successfully.' });
		},
	}),
	makeRoute({
		path: '/permissions/revoke',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const parsed = revokePermissionSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return json(c, 400, { error: parseZodError(parsed.error) });

			const { userId, resourceType, resourceId } = parsed.data;

			switch (resourceType) {
				case 'group': {
					const group = await db(manager, 'group', 'findUnique', { where: { groupId: resourceId } });
					if (!group) return json(c, 404, { error: 'Group not found.' });

					const canManage = await canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId: resourceId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					break;
				}
				case 'category': {
					const category = await db(manager, 'category', 'findUnique', { where: { categoryId: resourceId }, select: { groupId: true } });
					if (!category) return json(c, 404, { error: 'Category not found.' });

					const canManage = await canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId: resourceId, groupId: category.groupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					break;
				}
				case 'board': {
					const board = await db(manager, 'board', 'findUnique', { where: { boardId: resourceId }, select: { category: { select: { groupId: true, categoryId: true } } } });
					if (!board) return json(c, 404, { error: 'Board not found.' });

					const canManage = await canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId: resourceId, categoryId: board.category.categoryId, groupId: board.category.groupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					break;
				}
				default: return json(c, 400, { error: 'Invalid resource type. Must be one of: group, category, board.' });
			}

			let deleted: GetBatchResult | null;
			switch (resourceType) {
				case 'group': deleted = await db(manager, 'groupPermission', 'deleteMany', { where: { userId, groupId: resourceId } }); break;
				case 'category': deleted = await db(manager, 'categoryPermission', 'deleteMany', { where: { userId, categoryId: resourceId } }); break;
				case 'board': deleted = await db(manager, 'boardPermission', 'deleteMany', { where: { userId, boardId: resourceId } }); break;
			}

			if (!deleted || deleted.count === 0) return json(c, 404, { error: 'Permission not found.' });
			return json(c, 200, { data: 'Permission revoked successfully.' });
		},
	}),
];

// Validation Schemas.
export type CreateInviteRequest = z.infer<typeof createInviteSchema>;

export const createInviteSchema = z.object({
	groupIds: z.array(z.string()).optional(),
	categoryIds: z.array(z.string()).optional(),
	boardIds: z.array(z.string()).optional(),

	groupRole: z.enum(GroupRole).optional(),
	categoryRole: z.enum(CategoryRole).optional(),
	boardRole: z.enum(BoardRole).optional(),

	expiresIn: z.number().min(1).max(30).default(7),
	maxUses: z.number().min(1).optional(),
}).refine((data) => !!(data.groupIds || data.categoryIds || data.boardIds), {
	message: 'At least one of groupIds, categoryIds, or boardIds must be provided.',
}).refine((data) => {
	if (data.groupIds && data.groupIds.length > 0 && !data.groupRole) return false;
	if (data.categoryIds && data.categoryIds.length > 0 && !data.categoryRole) return false;
	if (data.boardIds && data.boardIds.length > 0 && !data.boardRole) return false;
	return true;
}, {
	message: 'Roles must be specified for each resource type provided.',
});

export type GrantPermissionsRequest = z.infer<typeof grantPermissionSchema>;

export const grantPermissionSchema = z.object({
	userId: z.string(),

	groupIds: z.array(z.string()).optional(),
	categoryIds: z.array(z.string()).optional(),
	boardIds: z.array(z.string()).optional(),

	groupRole: z.enum(GroupRole).optional(),
	categoryRole: z.enum(CategoryRole).optional(),
	boardRole: z.enum(BoardRole).optional(),
}).refine((data) => !!(data.groupIds || data.categoryIds || data.boardIds), {
	message: 'At least one of groupIds, categoryIds, or boardIds must be provided.',
}).refine((data) => {
	if (data.groupIds && data.groupIds.length > 0 && !data.groupRole) return false;
	if (data.categoryIds && data.categoryIds.length > 0 && !data.categoryRole) return false;
	if (data.boardIds && data.boardIds.length > 0 && !data.boardRole) return false;
	return true;
}, {
	message: 'Roles must be specified for each resource type provided.',
});

export const revokePermissionSchema = z.object({
	userId: z.string(),
	resourceType: z.enum(['group', 'category', 'board']),
	resourceId: z.string(),
});
