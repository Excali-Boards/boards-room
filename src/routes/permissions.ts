import { processPermissionGrants, applyPermissionGrants, canManagePermissions, collectResourcePermissions, getPermissionCheckData, canGrantRole, getUserHighestRole } from '../other/permissions.js';
import { addPermission, parseZodError } from '../modules/functions.js';
import { BoardRole, CategoryRole, GroupRole } from '@prisma/client';
import { GrantedEntry, PermUser, ResourceType } from '../types.js';
import { GetBatchResult } from '@prisma/client/runtime/library';
import { json, makeRoute } from '../services/routes.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
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

			const resourceId = c.req.query('id');
			if (!resourceId) return json(c, 400, { error: 'Missing resource ID.' });

			const { usersWithAccess, resource } = await collectResourcePermissions(
				resourceType,
				resourceId,
				manager,
			);

			if (!resource) return json(c, 404, { error: `${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} not found.` });

			const permCheckData = await getPermissionCheckData(resourceType, resourceId, manager);
			if (!permCheckData) return json(c, 404, { error: 'Resource not found.' });

			const canView = canManagePermissions(c.var.DBUser, permCheckData);
			if (!canView) return json(c, 403, { error: 'No permission' });

			const userIds = Array.from(usersWithAccess.keys());
			const users = userIds.length ? (await db(manager, 'user', 'findMany', {
				where: { userId: { in: userIds } },
				select: { userId: true, email: true, displayName: true, avatarUrl: true },
			})) || [] : [];

			const result: PermUser[] = users.map((user) => ({
				...user,
				permissions: usersWithAccess.get(user.userId) || [],
			}));

			return json(c, 200, { data: result });
		},
	}),
	makeRoute({
		path: '/permissions/view-all',
		method: 'POST',
		enabled: true,
		devOnly: true,
		auth: true,

		handler: async (c) => {
			const isValid = getAllUserPermissionsSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const userIds = isValid.data.userIds;

			const results = await Promise.allSettled([
				db(manager, 'user', 'findMany', { where: { userId: { in: userIds } }, select: { userId: true, email: true, displayName: true, avatarUrl: true } }).catch(() => null),

				db(manager, 'boardPermission', 'findMany', { where: { userId: { in: userIds } }, select: { userId: true, boardId: true, role: true } }).catch(() => null),
				db(manager, 'categoryPermission', 'findMany', { where: { userId: { in: userIds } }, select: { userId: true, categoryId: true, role: true } }).catch(() => null),
				db(manager, 'groupPermission', 'findMany', { where: { userId: { in: userIds } }, select: { userId: true, groupId: true, role: true } }).catch(() => null),

				db(manager, 'board', 'findMany', {
					select: {
						boardId: true,
						name: true,
						category: {
							select: {
								categoryId: true,
								name: true,
								group: { select: { groupId: true, name: true } },
							},
						},
					},
				}).catch(() => null),

				db(manager, 'category', 'findMany', {
					select: {
						categoryId: true,
						name: true,
						group: { select: { groupId: true, name: true } },
					},
				}).catch(() => null),

				db(manager, 'group', 'findMany', {
					select: { groupId: true, name: true },
				}).catch(() => null),
			]);

			const allUsers = results[0].status === 'fulfilled' && results[0].value ? results[0].value : [];

			const allBoardPerms = results[1].status === 'fulfilled' && results[1].value ? results[1].value : [];
			const allCategoryPerms = results[2].status === 'fulfilled' && results[2].value ? results[2].value : [];
			const allGroupPerms = results[3].status === 'fulfilled' && results[3].value ? results[3].value : [];

			const allBoards = results[4].status === 'fulfilled' && results[4].value ? results[4].value : [];
			const allCategories = results[5].status === 'fulfilled' && results[5].value ? results[5].value : [];
			const allGroups = results[6].status === 'fulfilled' && results[6].value ? results[6].value : [];

			const boardMap = new Map(allBoards.map((b) => [b.boardId, b]) || []);
			const categoryMap = new Map(allCategories.map((c) => [c.categoryId, c]) || []);
			const groupMap = new Map(allGroups.map((g) => [g.groupId, g]) || []);

			const result: Record<string, PermUser> = {};

			for (const userId of isValid.data.userIds) {
				const user = allUsers.find((u) => u.userId === userId);
				if (!user) continue;

				const userPermissions: Map<string, GrantedEntry[]> = new Map();

				for (const perm of allBoardPerms.filter((p) => p.userId === userId) || []) {
					const board = boardMap.get(perm.boardId);
					if (!board) continue;

					addPermission(userPermissions, userId, {
						type: 'board',
						role: perm.role,
						resourceId: board.boardId,
						basedOnType: 'board',
						basedOnResourceId: board.boardId,
						basedOnResourceName: board.name,
					});
				}

				for (const perm of allCategoryPerms.filter((p) => p.userId === userId) || []) {
					const category = categoryMap.get(perm.categoryId);
					if (!category) continue;

					addPermission(userPermissions, userId, {
						type: 'category',
						role: perm.role,
						resourceId: category.categoryId,
						basedOnType: 'category',
						basedOnResourceId: category.categoryId,
						basedOnResourceName: category.name,
					});

					for (const board of allBoards || []) {
						if (board.category.categoryId === perm.categoryId) {
							addPermission(userPermissions, userId, {
								type: 'board',
								role: perm.role,
								resourceId: board.boardId,
								basedOnType: 'category',
								basedOnResourceId: category.categoryId,
								basedOnResourceName: category.name,
							});
						}
					}
				}

				for (const perm of allGroupPerms.filter((p) => p.userId === userId) || []) {
					const group = groupMap.get(perm.groupId);
					if (!group) continue;

					addPermission(userPermissions, userId, {
						type: 'group',
						role: perm.role,
						resourceId: group.groupId,
						basedOnType: 'group',
						basedOnResourceId: group.groupId,
						basedOnResourceName: group.name,
					});

					for (const category of allCategories || []) {
						if (category.group.groupId === perm.groupId) {
							addPermission(userPermissions, userId, {
								type: 'category',
								role: perm.role,
								resourceId: category.categoryId,
								basedOnType: 'group',
								basedOnResourceId: group.groupId,
								basedOnResourceName: group.name,
							});
						}
					}

					for (const board of allBoards || []) {
						if (board.category.group.groupId === perm.groupId) {
							addPermission(userPermissions, userId, {
								type: 'board',
								role: perm.role,
								resourceId: board.boardId,
								basedOnType: 'group',
								basedOnResourceId: group.groupId,
								basedOnResourceName: group.name,
							});
						}
					}
				}

				result[userId] = { ...user, permissions: userPermissions.get(userId) || [] };
			}

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
						canManage = canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this group (ID: ${groupId}).` });

						const granterRole = getUserHighestRole(c.var.DBUser, { type: 'group', data: { groupId } });
						if (groupRole && granterRole && !canGrantRole(granterRole, groupRole)) return json(c, 403, { error: `You cannot grant ${groupRole} role. You can only grant roles below your own level.` });
					}
				}

				if (categoryIds && categoryIds.length > 0 && canManage) {
					const DBCategories = await db(manager, 'category', 'findMany', { where: { categoryId: { in: categoryIds } }, select: { groupId: true, categoryId: true } }) || [];
					if (DBCategories.length !== categoryIds.length) return json(c, 400, { error: 'Some categories do not exist.' });

					for (const categoryId of categoryIds) {
						const groupId = DBCategories.find((c) => c.categoryId === categoryId)?.groupId;
						if (!groupId) return json(c, 400, { error: `Category (ID: ${categoryId}) does not belong to a valid group.` });

						canManage = canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this category (ID: ${categoryId}).` });

						const granterRole = getUserHighestRole(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
						if (categoryRole && granterRole && !canGrantRole(granterRole, categoryRole)) return json(c, 403, { error: `You cannot grant ${categoryRole} role. You can only grant roles below your own level.` });
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

						canManage = canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId, groupId, categoryId } });
						if (!canManage) return json(c, 403, { error: `You do not have permission to create invites for this board (ID: ${boardId}).` });

						const granterRole = getUserHighestRole(c.var.DBUser, { type: 'board', data: { boardId, groupId, categoryId } });
						if (boardRole && granterRole && !canGrantRole(granterRole, boardRole)) return json(c, 403, { error: `You cannot grant ${boardRole} role. You can only grant roles below your own level.` });
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

					const canManage = canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId: resourceId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					if (!c.var.isDev) {
						const targetUserPerm = await db(manager, 'groupPermission', 'findFirst', { where: { userId, groupId: resourceId }, select: { role: true } });
						if (targetUserPerm) {
							const granterRole = getUserHighestRole(c.var.DBUser, { type: 'group', data: { groupId: resourceId } });
							if (granterRole && !canGrantRole(granterRole, targetUserPerm.role)) return json(c, 403, { error: `You cannot revoke ${targetUserPerm.role} role. You can only manage roles below your own level.` });
						}
					}

					break;
				}
				case 'category': {
					const category = await db(manager, 'category', 'findUnique', { where: { categoryId: resourceId }, select: { groupId: true } });
					if (!category) return json(c, 404, { error: 'Category not found.' });

					const canManage = canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId: resourceId, groupId: category.groupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					if (!c.var.isDev) {
						const targetUserPerm = await db(manager, 'categoryPermission', 'findFirst', { where: { userId, categoryId: resourceId }, select: { role: true } });
						if (targetUserPerm) {
							const granterRole = getUserHighestRole(c.var.DBUser, { type: 'category', data: { categoryId: resourceId, groupId: category.groupId } });
							if (granterRole && !canGrantRole(granterRole, targetUserPerm.role)) return json(c, 403, { error: `You cannot revoke ${targetUserPerm.role} role. You can only manage roles below your own level.` });
						}
					}

					break;
				}
				case 'board': {
					const board = await db(manager, 'board', 'findUnique', { where: { boardId: resourceId }, select: { category: { select: { groupId: true, categoryId: true } } } });
					if (!board) return json(c, 404, { error: 'Board not found.' });

					const canManage = canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId: resourceId, categoryId: board.category.categoryId, groupId: board.category.groupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to revoke access to this resource.' });

					if (!c.var.isDev) {
						const targetUserPerm = await db(manager, 'boardPermission', 'findFirst', { where: { userId, boardId: resourceId }, select: { role: true } });
						if (targetUserPerm) {
							const granterRole = getUserHighestRole(c.var.DBUser, { type: 'board', data: { boardId: resourceId, categoryId: board.category.categoryId, groupId: board.category.groupId } });
							if (granterRole && !canGrantRole(granterRole, targetUserPerm.role)) return json(c, 403, { error: `You cannot revoke ${targetUserPerm.role} role. You can only manage roles below your own level.` });
						}
					}

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

// Schemas.
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

export const getAllUserPermissionsSchema = z.object({
	userIds: z.union([z.string(), z.array(z.string())]).transform((val) => typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : val),
});
