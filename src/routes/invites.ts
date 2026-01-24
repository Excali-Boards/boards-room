import { canManagePermissions, isValidRoleForResource, generateInviteCode, processPermissionGrants, applyPermissionGrants, canGrantRole, getUserHighestRole } from '../other/permissions.js';
import type { InviteData, ResourceType } from '../types.js';
import { parseZodError } from '../modules/functions.js';
import { json, makeRoute } from '../services/routes.js';
import { createInviteSchema } from './permissions.js';
import { Invite } from '@prisma/client';
import { db } from '../core/prisma.js';
import manager from '../index.js';

export default [
	makeRoute({
		path: '/invites',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const invites = await db(manager, 'user', 'findUnique', {
				where: { userId: c.var.DBUser.userId },
				select: {
					createdInvites: {
						include: {
							creator: { select: { userId: true, displayName: true, avatarUrl: true } },
						},
					},
				},
			});

			if (!invites) return json(c, 500, { error: 'Failed to retrieve invites.' });

			const allGroupsIds = Array.from(new Set(invites.createdInvites.flatMap((i) => i.groupIds)));
			const allCategoriesIds = Array.from(new Set(invites.createdInvites.flatMap((i) => i.categoryIds)));
			const allBoardsIds = Array.from(new Set(invites.createdInvites.flatMap((i) => i.boardIds)));

			const [allGroups, allCategories, allBoards] = await Promise.all([
				allGroupsIds.length ? db(manager, 'group', 'findMany', {
					where: { groupId: { in: allGroupsIds } },
					select: { groupId: true, name: true },
				}) : [],
				allCategoriesIds.length ? db(manager, 'category', 'findMany', {
					where: { categoryId: { in: allCategoriesIds } },
					select: { categoryId: true, name: true, groupId: true },
				}) : [],
				allBoardsIds.length ? db(manager, 'board', 'findMany', {
					where: { boardId: { in: allBoardsIds } },
					select: { boardId: true, name: true, categoryId: true },
				}) : [],
			]);

			const invitesData: InviteData[] = invites.createdInvites.map((invite) => ({
				code: invite.code,
				expiresAt: invite.expiresAt,
				maxUses: invite.maxUses,
				currentUses: invite.currentUses,
				boardRole: invite.boardRole,
				categoryRole: invite.categoryRole,
				groupRole: invite.groupRole,
				groups: (allGroups || []).filter((g) => invite.groupIds.includes(g.groupId)),
				categories: (allCategories || []).filter((c) => invite.categoryIds.includes(c.categoryId)),
				boards: (allBoards || []).filter((b) => invite.boardIds.includes(b.boardId)).map((b) => ({
					boardId: b.boardId,
					name: b.name,
					categoryId: b.categoryId,
				})),
			}));

			return json(c, 200, {
				data: {
					invites: invitesData,
					canInvite: c.var.isDev
						|| c.var.DBUser.groupPermissions.some((gp) => gp.role === 'GroupAdmin')
						|| c.var.DBUser.categoryPermissions.some((cp) => cp.role === 'CategoryAdmin'),
				},
			});
		},
	}),
	makeRoute({
		path: '/invites',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const parsed = createInviteSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return json(c, 400, { error: parseZodError(parsed.error) });

			const { groupIds, categoryIds, boardIds, groupRole, categoryRole, boardRole, expiresIn, maxUses } = parsed.data;

			let canManage = true;
			let failedResource: { type: ResourceType; id: string } | null = null;

			if (groupIds && groupIds.length > 0) {
				for (const groupId of groupIds) {
					canManage = canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId } });
					if (!canManage) {
						failedResource = { type: 'group', id: groupId };
						break;
					}

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
					if (!canManage) {
						failedResource = { type: 'category', id: categoryId };
						break;
					}

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
					if (!canManage) {
						failedResource = { type: 'board', id: boardId };
						break;
					}

					const granterRole = getUserHighestRole(c.var.DBUser, { type: 'board', data: { boardId, groupId, categoryId } });
					if (boardRole && granterRole && !canGrantRole(granterRole, boardRole)) return json(c, 403, { error: `You cannot grant ${boardRole} role. You can only grant roles below your own level.` });
				}
			}

			if (!canManage) {
				if (!failedResource) return json(c, 500, { error: 'Failed to determine which resource permission check failed.' });
				return json(c, 403, { error: `You do not have permission to create invites for this ${failedResource.type} (ID: ${failedResource.id}).` });
			}

			if (groupIds && groupIds.length > 0 && groupRole && !isValidRoleForResource(groupRole, 'group')) return json(c, 400, { error: 'Invalid role for group invite.' });
			else if (categoryIds && categoryIds.length > 0 && categoryRole && !isValidRoleForResource(categoryRole, 'category')) return json(c, 400, { error: 'Invalid role for category invite.' });
			else if (boardIds && boardIds.length > 0 && boardRole && !isValidRoleForResource(boardRole, 'board')) return json(c, 400, { error: 'Invalid role for board invite.' });

			const code = generateInviteCode();
			const expiresAt = new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000);

			const inviteData = {
				code,
				createdBy: c.var.DBUser.userId,
				expiresAt,
				maxUses: maxUses || 1,
				groupIds: groupIds || [],
				categoryIds: categoryIds || [],
				boardIds: boardIds || [],
				groupRole: groupRole || null,
				categoryRole: categoryRole || null,
				boardRole: boardRole || null,
			};

			const DBInvite = await db(manager, 'invite', 'create', { data: inviteData });
			if (!DBInvite) return json(c, 500, { error: 'Failed to create invite. Please try again.' });

			return json(c, 200, {
				data: {
					code: DBInvite.code,
					expiresAt: DBInvite.expiresAt,
					maxUses: DBInvite.maxUses,
				},
			});
		},
	}),
	makeRoute({
		path: '/invites/:code',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const code = c.req.param('code');

			const DBInvite = await db(manager, 'invite', 'findUnique', { where: { code }, include: { creator: { select: { userId: true, displayName: true, avatarUrl: true } } } });
			if (!DBInvite) return json(c, 404, { error: 'Invite not found.' });

			return json(c, 200, {
				data: {
					code: DBInvite.code,
					maxUses: DBInvite.maxUses,
					expiresAt: DBInvite.expiresAt,
					currentUses: DBInvite.currentUses,
					invitedBy: {
						userId: DBInvite.creator.userId,
						displayName: DBInvite.creator.displayName,
						avatarUrl: DBInvite.creator.avatarUrl,
					},
				},
			});
		},
	}),
	makeRoute({
		path: '/invites/:code',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const code = c.req.param('code');

			const DBInvite = await db(manager, 'invite', 'findUnique', { where: { code } });
			if (!DBInvite) return json(c, 404, { error: 'Invite not found.' });

			if (DBInvite.expiresAt && DBInvite.expiresAt < new Date()) {
				await db(manager, 'invite', 'delete', { where: { dbId: DBInvite.dbId } }).catch(() => null);
				return json(c, 400, { error: 'Invite has expired.' });
			}

			if (DBInvite.maxUses && DBInvite.currentUses >= DBInvite.maxUses) {
				await db(manager, 'invite', 'delete', { where: { dbId: DBInvite.dbId } }).catch(() => null);
				return json(c, 400, { error: 'Invite has reached its usage limit.' });
			}

			const userId = c.var.DBUser.userId;
			if (DBInvite.createdBy === userId) return json(c, 400, { error: 'You cannot use an invite you created yourself.' });

			const permissionResult = await processPermissionGrants(manager, {
				userId,
				groupIds: DBInvite.groupIds,
				categoryIds: DBInvite.categoryIds,
				boardIds: DBInvite.boardIds,
				groupRole: DBInvite.groupRole || undefined,
				categoryRole: DBInvite.categoryRole || undefined,
				boardRole: DBInvite.boardRole || undefined,
			});

			if (permissionResult.newPermissions.length === 0 && permissionResult.updatedPermissions.length === 0) {
				return json(c, 400, { error: 'You already have equal or higher permissions for all resources in this invite.' });
			}

			await applyPermissionGrants(manager, permissionResult, DBInvite.createdBy, userId);

			if (!c.var.DBUser.invitedBy) {
				await db(manager, 'user', 'update', {
					where: { userId },
					data: { invitedBy: DBInvite.createdBy },
				}).catch(() => null);
			}

			await db(manager, 'invite', 'update', { where: { dbId: DBInvite.dbId }, data: { currentUses: { increment: 1 } } }).catch(() => null); const allGrantedPermissions = [
				...permissionResult.newPermissions,
				...permissionResult.updatedPermissions.map((update) => ({ type: update.type, resourceId: update.resourceId, role: update.role })),
			];

			const allResourceIds = {
				'group': allGrantedPermissions.filter((p) => p.type === 'group').map((p) => p.resourceId),
				'category': allGrantedPermissions.filter((p) => p.type === 'category').map((p) => p.resourceId),
				'board': allGrantedPermissions.filter((p) => p.type === 'board').map((p) => p.resourceId),
			};

			const allGroupsIds = Array.from(new Set(allResourceIds.group));
			const allCategoriesIds = Array.from(new Set(allResourceIds.category));
			const allBoardsIds = Array.from(new Set(allResourceIds.board));

			const [allGroups, allCategories, allBoards] = await Promise.all([
				allGroupsIds.length ? db(manager, 'group', 'findMany', {
					where: { groupId: { in: allGroupsIds } },
					select: { groupId: true, name: true },
				}) : [],
				allCategoriesIds.length ? db(manager, 'category', 'findMany', {
					where: { categoryId: { in: allCategoriesIds } },
					select: { categoryId: true, name: true, groupId: true },
				}) : [],
				allBoardsIds.length ? db(manager, 'board', 'findMany', {
					where: { boardId: { in: allBoardsIds } },
					select: { boardId: true, name: true, categoryId: true },
				}) : [],
			]);

			if (DBInvite.maxUses && DBInvite.currentUses + 1 >= DBInvite.maxUses) {
				await db(manager, 'invite', 'delete', { where: { dbId: DBInvite.dbId } }).catch(() => null);
			}

			return json(c, 200, {
				data: {
					granted: allGrantedPermissions,
					details: {
						groups: allGroups,
						categories: allCategories,
						boards: allBoards,
					},
				},
			});
		},
	}),
	makeRoute({
		path: '/invites/:code',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const code = c.req.param('code');

			const DBInvite = await db(manager, 'invite', 'findUnique', { where: { code } });
			if (!DBInvite) return json(c, 404, { error: 'Invite not found.' });
			else if (DBInvite.createdBy !== c.var.DBUser.userId) return json(c, 403, { error: 'You do not have permission to renew this invite.' });

			const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
			const updated = await db(manager, 'invite', 'update', { where: { dbId: DBInvite.dbId }, data: { expiresAt: newExpiry } });
			if (!updated) return json(c, 500, { error: 'Failed to renew invite. Please try again.' });

			return json(c, 200, {
				data: {
					code: updated.code,
					expiresAt: updated.expiresAt,
					maxUses: updated.maxUses,
					currentUses: updated.currentUses,
				},
			});
		},
	}),
	makeRoute({
		path: '/invites/:code',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const code = c.req.param('code');

			const DBInvite = await db(manager, 'invite', 'findUnique', { where: { code } });
			if (!DBInvite) return json(c, 404, { error: 'Invite not found.' });
			else if (DBInvite.createdBy !== c.var.DBUser.userId) return json(c, 403, { error: 'You do not have permission to revoke this invite.' });

			const deleted = await db(manager, 'invite', 'delete', { where: { dbId: DBInvite.dbId } });
			if (!deleted) return json(c, 500, { error: 'Failed to revoke invite. Please try again.' });

			return json(c, 200, { data: 'Invite revoked successfully.' });
		},
	}),

	makeRoute({
		path: '/resources/invites',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const resourceType = c.req.query('type') as ResourceType;
			if (!resourceType) return json(c, 400, { error: 'Invalid or missing resource type. Must be one of: group, category, board.' });

			const resourceGroupId = c.req.query('groupId');
			const resourceCategoryId = c.req.query('categoryId');
			const resourceBoardId = c.req.query('boardId');

			let invites: Invite[] = [];

			switch (resourceType) {
				case 'board': {
					if (!resourceBoardId || !resourceCategoryId || !resourceGroupId) return json(c, 400, { error: 'Missing resource identifiers. Must provide groupId, categoryId, and boardId for board resources.' });

					const canManage = canManagePermissions(c.var.DBUser, { type: 'board', data: { boardId: resourceBoardId, categoryId: resourceCategoryId, groupId: resourceGroupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to view this resource.' });

					invites = await db(manager, 'invite', 'findMany', {
						where: {
							OR: [
								{ boardIds: { has: resourceBoardId } },
								{ categoryIds: { has: resourceCategoryId } },
								{ groupIds: { has: resourceGroupId } },
							],
						},
					}) || [];

					break;
				}
				case 'category': {
					if (!resourceCategoryId || !resourceGroupId) return json(c, 400, { error: 'Missing resource identifiers. Must provide groupId and categoryId for category resources.' });

					const canManage = canManagePermissions(c.var.DBUser, { type: 'category', data: { categoryId: resourceCategoryId, groupId: resourceGroupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to view this resource.' });

					invites = await db(manager, 'invite', 'findMany', {
						where: {
							OR: [
								{ categoryIds: { has: resourceCategoryId } },
								{ groupIds: { has: resourceGroupId } },
							],
						},
					}) || [];

					break;
				}
				case 'group': {
					if (!resourceGroupId) return json(c, 400, { error: 'Missing resource identifier. Must provide groupId for group resources.' });

					const canManage = canManagePermissions(c.var.DBUser, { type: 'group', data: { groupId: resourceGroupId } });
					if (!canManage) return json(c, 403, { error: 'You do not have permission to view this resource.' });

					invites = await db(manager, 'invite', 'findMany', {
						where: {
							groupIds: { has: resourceGroupId },
						},
					}) || [];

					break;
				}
			}

			const allGroupsIds = Array.from(new Set(invites.flatMap((i) => i.groupIds)));
			const allCategoriesIds = Array.from(new Set(invites.flatMap((i) => i.categoryIds)));
			const allBoardsIds = Array.from(new Set(invites.flatMap((i) => i.boardIds)));

			const allGroups = allGroupsIds.length ? await db(manager, 'group', 'findMany', { where: { groupId: { in: allGroupsIds } }, select: { groupId: true, name: true } }) || [] : [];
			const allCategories = allCategoriesIds.length ? await db(manager, 'category', 'findMany', { where: { categoryId: { in: allCategoriesIds } }, select: { categoryId: true, name: true, groupId: true } }) || [] : [];
			const allBoards = allBoardsIds.length ? await db(manager, 'board', 'findMany', { where: { boardId: { in: allBoardsIds } }, select: { boardId: true, name: true, categoryId: true } }) || [] : [];

			const InvitesData: InviteData[] = invites.map((invite) => {
				return {
					code: invite.code,
					expiresAt: invite.expiresAt,
					maxUses: invite.maxUses,
					currentUses: invite.currentUses,

					boardRole: invite.boardRole,
					categoryRole: invite.categoryRole,
					groupRole: invite.groupRole,

					groups: allGroups.filter((g) => invite.groupIds.includes(g.groupId)),
					categories: allCategories.filter((c) => invite.categoryIds.includes(c.categoryId)),
					boards: allBoards.filter((b) => invite.boardIds.includes(b.boardId)).map((b) => ({
						boardId: b.boardId,
						name: b.name,
						categoryId: b.categoryId,
					})),
				};
			});

			return json(c, 200, { data: InvitesData });
		},
	}),
];
