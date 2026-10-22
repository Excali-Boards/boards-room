import { PermissionGrantResult, UserRole, GlobalRole, ResourceType, AccessLevel, GlobalResourceType, ResourceReturnEnum, ResourceTypeGeneric, GrantedRoles, GrantedRole, GrantedEntry, ResourcePermissionsResult, PermissionCheckData, ResourceId } from '../types.js';
import { addPermission, getBoardResourceId, getCategoryResourceId, getGroupResourceId, securityUtils } from '../modules/functions.js';
import { BoardRole, CategoryRole, GroupRole } from '@prisma/client';
import { GrantPermissionsRequest } from '../routes/permissions.js';
import { db, invalidateCacheForWrite } from '../core/prisma.js';
import { DBUserPartialType } from './vars.js';
import { BoardsManager } from '../index.js';
import config from '../core/config.js';
import crypto from 'crypto';

const developerCache = new Map<string, boolean>();

// This hierarchy represents CAPABILITY LEVELS, not role inheritance!
export const PermissionHierarchy: Record<UserRole, number> = {
	[BoardRole.BoardViewer]: 1,
	[BoardRole.BoardCollaborator]: 2,

	[CategoryRole.CategoryViewer]: 3,
	[CategoryRole.CategoryCollaborator]: 4,
	[CategoryRole.CategoryManager]: 5,
	[CategoryRole.CategoryAdmin]: 6,

	[GroupRole.GroupViewer]: 7,
	[GroupRole.GroupCollaborator]: 8,
	[GroupRole.GroupManager]: 9,
	[GroupRole.GroupAdmin]: 10,

	[GlobalRole.Developer]: 11,
};

export const ResourceRank: Record<ResourceType, number> = {
	group: 1,
	category: 2,
	board: 3,
};

const AccessLevelRank: Record<AccessLevel, number> = {
	read: 1,
	write: 2,
	manage: 3,
	admin: 4,
};

/**
 * Returns the access level a role provides on a particular resource type.
 * PermissionHierarchy is intentionally not used here: it describes who may
 * grant which roles, not how inherited permissions compare on a resource.
 */
export function getRoleAccessLevel(resourceType: ResourceType, role: UserRole): AccessLevel | null {
	switch (resourceType) {
		case 'board': {
			if (role === BoardRole.BoardViewer || role === CategoryRole.CategoryViewer || role === GroupRole.GroupViewer) return 'read';
			if (role === BoardRole.BoardCollaborator || role === CategoryRole.CategoryCollaborator || role === GroupRole.GroupCollaborator) return 'write';
			if (role === CategoryRole.CategoryManager || role === GroupRole.GroupManager) return 'manage';
			if (role === CategoryRole.CategoryAdmin || role === GroupRole.GroupAdmin || role === GlobalRole.Developer) return 'admin';
			break;
		}
		case 'category': {
			if (role === CategoryRole.CategoryViewer || role === GroupRole.GroupViewer) return 'read';
			if (role === CategoryRole.CategoryCollaborator || role === GroupRole.GroupCollaborator) return 'write';
			if (role === CategoryRole.CategoryManager || role === GroupRole.GroupManager) return 'manage';
			if (role === CategoryRole.CategoryAdmin || role === GroupRole.GroupAdmin || role === GlobalRole.Developer) return 'admin';
			break;
		}
		case 'group': {
			if (role === GroupRole.GroupViewer) return 'read';
			if (role === GroupRole.GroupCollaborator) return 'write';
			if (role === GroupRole.GroupManager) return 'manage';
			if (role === GroupRole.GroupAdmin || role === GlobalRole.Developer) return 'admin';
			break;
		}
	}

	return null;
}

export function getResourceRoleRank(resourceType: ResourceType, role: UserRole): number {
	const accessLevel = getRoleAccessLevel(resourceType, role);
	return accessLevel ? AccessLevelRank[accessLevel] : 0;
}

export function isDeveloper(email: string): boolean {
	if (developerCache.has(email)) return developerCache.get(email)!;

	const result = config.developers.includes(securityUtils.decrypt(email));
	developerCache.set(email, result);
	return result;
}

export function getUserHighestRole<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>): ResourceReturnEnum<A> | null {
	if (isDeveloper(DBUser.email)) return GlobalRole.Developer as ResourceReturnEnum<A>;

	const roles: UserRole[] = [];

	switch (resource.type) {
		case 'board': {
			const resourceIds = getBoardResourceId(resource as ResourceTypeGeneric<'board'>);
			if (!resourceIds) break;

			const boardPerm = resourceIds.boardId && DBUser.boardPermissions.find((bp) => bp.boardId === resourceIds.boardId);
			if (boardPerm) roles.push(boardPerm.role);

			const categoryPerm = resourceIds.categoryId && DBUser.categoryPermissions.find((cp) => cp.categoryId === resourceIds.categoryId);
			if (categoryPerm) roles.push(categoryPerm.role);

			const groupPerm = resourceIds.groupId && DBUser.groupPermissions.find((gp) => gp.groupId === resourceIds.groupId);
			if (groupPerm) roles.push(groupPerm.role);
			break;
		}
		case 'category': {
			const resourceIds = getCategoryResourceId(resource as ResourceTypeGeneric<'category'>);
			if (!resourceIds) break;

			const categoryPerm = DBUser.categoryPermissions.find((cp) => cp.categoryId === resourceIds.categoryId);
			if (categoryPerm) roles.push(categoryPerm.role);

			const groupPerm = DBUser.groupPermissions.find((gp) => gp.groupId === resourceIds.groupId);
			if (groupPerm) roles.push(groupPerm.role);
			break;
		}
		case 'group': {
			const resourceIds = getGroupResourceId(resource as ResourceTypeGeneric<'group'>);
			if (!resourceIds) break;

			const groupPerm = DBUser.groupPermissions.find((gp) => gp.groupId === resourceIds.groupId);
			if (groupPerm) roles.push(groupPerm.role);
			break;
		}
		case 'global': {
			if (isDeveloper(DBUser.email)) roles.push(GlobalRole.Developer);
			break;
		}
	}

	if (roles.length === 0) return null;
	return roles.reduce((highest, current) => PermissionHierarchy[current] > PermissionHierarchy[highest] ? current : highest) as ResourceReturnEnum<A>;
}

/**
 * Selects the role that provides the most access on this resource. This is
 * separate from getUserHighestRole because grant authority and resource
 * access are different things: GroupViewer is higher in the grant hierarchy,
 * but only read access on a board, while BoardCollaborator grants write access.
 */
export function getUserHighestAccessRole<A extends ResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>): ResourceReturnEnum<A> | null {
	if (isDeveloper(DBUser.email)) return GlobalRole.Developer as ResourceReturnEnum<A>;

	const roles: { role: UserRole; sourceType: ResourceType; }[] = [];

	switch (resource.type) {
		case 'board': {
			const resourceIds = getBoardResourceId(resource as ResourceTypeGeneric<'board'>);
			if (!resourceIds) break;

			const boardPerm = DBUser.boardPermissions.find((permission) => permission.boardId === resourceIds.boardId);
			if (boardPerm) roles.push({ role: boardPerm.role, sourceType: 'board' });

			const categoryPerm = DBUser.categoryPermissions.find((permission) => permission.categoryId === resourceIds.categoryId);
			if (categoryPerm) roles.push({ role: categoryPerm.role, sourceType: 'category' });

			const groupPerm = DBUser.groupPermissions.find((permission) => permission.groupId === resourceIds.groupId);
			if (groupPerm) roles.push({ role: groupPerm.role, sourceType: 'group' });
			break;
		}
		case 'category': {
			const resourceIds = getCategoryResourceId(resource as ResourceTypeGeneric<'category'>);
			if (!resourceIds) break;

			const categoryPerm = DBUser.categoryPermissions.find((permission) => permission.categoryId === resourceIds.categoryId);
			if (categoryPerm) roles.push({ role: categoryPerm.role, sourceType: 'category' });

			const groupPerm = DBUser.groupPermissions.find((permission) => permission.groupId === resourceIds.groupId);
			if (groupPerm) roles.push({ role: groupPerm.role, sourceType: 'group' });
			break;
		}
		case 'group': {
			const resourceIds = getGroupResourceId(resource as ResourceTypeGeneric<'group'>);
			const groupPerm = DBUser.groupPermissions.find((permission) => permission.groupId === resourceIds.groupId);
			if (groupPerm) roles.push({ role: groupPerm.role, sourceType: 'group' });
			break;
		}
	}

	if (roles.length === 0) return null;

	return roles.reduce((highest, current) => {
		const currentRank = getResourceRoleRank(resource.type, current.role);
		const highestRank = getResourceRoleRank(resource.type, highest.role);

		if (currentRank > highestRank) return current;
		if (currentRank === highestRank && ResourceRank[current.sourceType] > ResourceRank[highest.sourceType]) return current;
		return highest;
	}).role as ResourceReturnEnum<A>;
}

export function getAccessLevel<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): AccessLevel | null {
	const role = resource.type === 'global' ? userHighestRole || getUserHighestRole(DBUser, resource) : getUserHighestAccessRole(DBUser, resource as ResourceTypeGeneric<ResourceType>) || userHighestRole;
	if (!role) {
		if (resource.type === 'group') {
			const hasAnyCategoryAccess = DBUser.categoryPermissions.length > 0;
			const hasAnyBoardAccess = DBUser.boardPermissions.length > 0;
			if (hasAnyCategoryAccess || hasAnyBoardAccess) return 'read';
		}

		if (resource.type === 'category') {
			const hasAnyBoardAccess = DBUser.boardPermissions.length > 0;
			if (hasAnyBoardAccess) return 'read';
		}

		return null;
	}

	return resource.type === 'global' ? role === GlobalRole.Developer ? 'admin' : null : getRoleAccessLevel(resource.type, role);
}

export function canView<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const accessLevel = getAccessLevel(DBUser, resource, userHighestRole);
	return accessLevel !== null;
}

export function canEdit<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const accessLevel = getAccessLevel(DBUser, resource, userHighestRole);
	return accessLevel === 'write' || accessLevel === 'manage' || accessLevel === 'admin';
}

export function canManage<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const accessLevel = getAccessLevel(DBUser, resource, userHighestRole);
	return accessLevel === 'manage' || accessLevel === 'admin';
}

export function canManagePermissions<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>): boolean {
	switch (resource.type) {
		case 'global': return isDeveloper(DBUser.email);
		case 'group': {
			const { groupId } = (resource.data || {}) as ResourceId<'group'>;
			if (!groupId) return false;

			return isDeveloper(DBUser.email)
				|| DBUser.groupPermissions.some((gp) => gp.groupId === groupId && gp.role === GroupRole.GroupAdmin);
		}
		case 'category': {
			const { categoryId, groupId } = (resource.data || {}) as ResourceId<'category'>;
			if (!categoryId || !groupId) return false;

			return isDeveloper(DBUser.email)
				|| DBUser.categoryPermissions.some((cp) => cp.categoryId === categoryId && cp.role === CategoryRole.CategoryAdmin)
				|| DBUser.groupPermissions.some((gp) => gp.groupId === groupId && gp.role === GroupRole.GroupAdmin);
		}
		case 'board': {
			const { categoryId, groupId } = (resource.data || {}) as ResourceId<'board'>;
			if (!categoryId || !groupId) return false;

			return isDeveloper(DBUser.email)
				|| DBUser.categoryPermissions.some((cp) => cp.categoryId === categoryId && cp.role === CategoryRole.CategoryAdmin)
				|| DBUser.groupPermissions.some((gp) => gp.groupId === groupId && gp.role === GroupRole.GroupAdmin);
		}
	}

	return false;
}

export function canGrantRole(granterRole: UserRole, targetRole: UserRole): boolean {
	const granterLevel = PermissionHierarchy[granterRole];
	const targetLevel = PermissionHierarchy[targetRole];
	return granterLevel > targetLevel;
}

export function isValidRoleForResource(role: string, resourceType: ResourceType): boolean {
	switch (resourceType) {
		case 'group': return Object.values(GroupRole).includes(role as GroupRole);
		case 'category': return Object.values(CategoryRole).includes(role as CategoryRole);
		case 'board': return Object.values(BoardRole).includes(role as BoardRole);
		default: return false;
	}
}

export function hasAccessToBoardWithIds(DBUser: DBUserPartialType, boardId: string, categoryId: string, groupId: string): { hasAccess: boolean; canEdit: boolean; role: UserRole | null; } {
	const resource = {
		type: 'board' as const,
		data: { boardId, categoryId, groupId },
	};

	const userRole = getUserHighestRole(DBUser, resource);
	const hasAccess = canView(DBUser, resource, userRole || undefined);
	const canEditBoard = canEdit(DBUser, resource, userRole || undefined);

	return {
		hasAccess,
		canEdit: canEditBoard,
		role: userRole || null,
	};
}

export function getBoardAccessLevel(DBUser: DBUserPartialType, boardId: string, categoryId: string, groupId: string): AccessLevel | null {
	return getAccessLevel(DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
}

export function getCategoryAccessLevel(DBUser: DBUserPartialType, categoryId: string, groupId: string): AccessLevel | null {
	return getAccessLevel(DBUser, { type: 'category', data: { categoryId, groupId } });
}

export function getGroupAccessLevel(DBUser: DBUserPartialType, groupId: string): AccessLevel | null {
	return getAccessLevel(DBUser, { type: 'group', data: { groupId } });
}

export function canEditBoardWithIds(DBUser: DBUserPartialType, boardId: string, categoryId: string, groupId: string): boolean {
	return canEdit(DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
}

export function canManageBoardWithIds(DBUser: DBUserPartialType, boardId: string, categoryId: string, groupId: string): boolean {
	return canManage(DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
}

export function canManageCategoryWithIds(DBUser: DBUserPartialType, categoryId: string, groupId: string): boolean {
	return canManage(DBUser, { type: 'category', data: { categoryId, groupId } });
}

export function canManageGroupWithIds(DBUser: DBUserPartialType, groupId: string): boolean {
	return canManage(DBUser, { type: 'group', data: { groupId } });
}

export function generateInviteCode(): string {
	return crypto.randomBytes(16).toString('hex');
}

export async function processPermissionGrants(manager: BoardsManager, request: GrantPermissionsRequest): Promise<PermissionGrantResult> {
	const { userId, groupIds, categoryIds, boardIds, groupRole, categoryRole, boardRole } = request;
	const requestedGroupIds = groupIds || [];
	const requestedCategoryIds = categoryIds || [];
	const requestedBoardIds = boardIds || [];

	const newPermissions: GrantedRoles = [];
	const updatedPermissions: (GrantedRole & { dbId: string })[] = [];

	const [categories, boards] = await Promise.all([
		requestedCategoryIds.length ? db(manager, 'category', 'findMany', {
			where: { categoryId: { in: requestedCategoryIds } },
			select: { categoryId: true, groupId: true },
		}) : Promise.resolve([]),
		requestedBoardIds.length ? db(manager, 'board', 'findMany', {
			where: { boardId: { in: requestedBoardIds } },
			select: { boardId: true, categoryId: true, category: { select: { groupId: true } } },
		}) : Promise.resolve([]),
	]);

	const categoryMap = new Map((categories || []).map((category) => [category.categoryId, category]));
	const boardMap = new Map((boards || []).map((board) => [board.boardId, board]));
	const relevantCategoryIds = Array.from(new Set([
		...requestedCategoryIds,
		...(boards || []).map((board) => board.categoryId),
	]));
	const relevantGroupIds = Array.from(new Set([
		...requestedGroupIds,
		...(categories || []).map((category) => category.groupId),
		...(boards || []).map((board) => board.category.groupId),
	]));

	// Load direct permissions for the requested resources and inherited
	// permissions for their parents. A child grant is only needed when it
	// provides more access than the user already receives from its parents.
	const [existingGroupPerms, existingCategoryPerms, existingBoardPerms] = await Promise.all([
		relevantGroupIds.length ? db(manager, 'groupPermission', 'findMany', { where: { userId, groupId: { in: relevantGroupIds } } }) : Promise.resolve([]),
		relevantCategoryIds.length ? db(manager, 'categoryPermission', 'findMany', { where: { userId, categoryId: { in: relevantCategoryIds } } }) : Promise.resolve([]),
		requestedBoardIds.length ? db(manager, 'boardPermission', 'findMany', { where: { userId, boardId: { in: requestedBoardIds } } }) : Promise.resolve([]),
	]);

	const groupPermMap = new Map((existingGroupPerms || []).map((permission) => [permission.groupId, permission]));
	const categoryPermMap = new Map((existingCategoryPerms || []).map((permission) => [permission.categoryId, permission]));
	const boardPermMap = new Map((existingBoardPerms || []).map((permission) => [permission.boardId, permission]));

	if (requestedGroupIds.length && groupRole) {
		for (const groupId of requestedGroupIds) {
			const existing = groupPermMap.get(groupId);

			if (!existing) newPermissions.push({ type: 'group', resourceId: groupId, role: groupRole });
			else if (getResourceRoleRank('group', groupRole) > getResourceRoleRank('group', existing.role)) {
				updatedPermissions.push({
					type: 'group',
					resourceId: groupId,
					role: groupRole,
					dbId: existing.dbId,
				});
			}
		}
	}

	if (requestedCategoryIds.length && categoryRole) {
		for (const categoryId of requestedCategoryIds) {
			const existing = categoryPermMap.get(categoryId);
			const groupId = categoryMap.get(categoryId)?.groupId;
			const inheritedGroupRole = groupId ? groupPermMap.get(groupId)?.role : undefined;
			const inheritedRank = inheritedGroupRole ? getResourceRoleRank('category', inheritedGroupRole) : 0;
			const requestedRank = getResourceRoleRank('category', categoryRole);

			if (requestedRank <= inheritedRank) continue;

			if (!existing) newPermissions.push({ type: 'category', resourceId: categoryId, role: categoryRole });
			else if (requestedRank > getResourceRoleRank('category', existing.role)) {
				updatedPermissions.push({
					type: 'category',
					resourceId: categoryId,
					role: categoryRole,
					dbId: existing.dbId,
				});
			}
		}
	}

	if (requestedBoardIds.length && boardRole) {
		for (const boardId of requestedBoardIds) {
			const existing = boardPermMap.get(boardId);
			const board = boardMap.get(boardId);
			const categoryRoleForBoard = board ? categoryPermMap.get(board.categoryId)?.role : undefined;
			const groupRoleForBoard = board ? groupPermMap.get(board.category.groupId)?.role : undefined;
			const inheritedRank = Math.max(
				categoryRoleForBoard ? getResourceRoleRank('board', categoryRoleForBoard) : 0,
				groupRoleForBoard ? getResourceRoleRank('board', groupRoleForBoard) : 0,
			);
			const requestedRank = getResourceRoleRank('board', boardRole);

			if (requestedRank <= inheritedRank) continue;

			if (!existing) newPermissions.push({ type: 'board', resourceId: boardId, role: boardRole });
			else if (requestedRank > getResourceRoleRank('board', existing.role)) {
				updatedPermissions.push({
					type: 'board',
					resourceId: boardId,
					role: boardRole,
					dbId: existing.dbId,
				});
			}
		}
	}

	return { newPermissions, updatedPermissions };
}

export async function applyPermissionGrants(manager: BoardsManager, result: PermissionGrantResult, grantedBy: string, userId: string): Promise<void> {
	const { newPermissions, updatedPermissions } = result;
	let deletedCategoryPermissions = false;
	let deletedBoardPermissions = false;

	await manager.prisma.$transaction(async (tx) => {
		const groupPerms = newPermissions.filter((p) => p.type === 'group');
		const categoryPerms = newPermissions.filter((p) => p.type === 'category');
		const boardPerms = newPermissions.filter((p) => p.type === 'board');

		if (groupPerms.length > 0) {
			await tx.groupPermission.createMany({
				data: groupPerms.map((perm) => ({
					userId,
					groupId: perm.resourceId,
					role: perm.role as GroupRole,
					grantedBy,
				})),
			});
		}

		if (categoryPerms.length > 0) {
			await tx.categoryPermission.createMany({
				data: categoryPerms.map((perm) => ({
					userId,
					categoryId: perm.resourceId,
					role: perm.role as CategoryRole,
					grantedBy,
				})),
			});
		}

		if (boardPerms.length > 0) {
			await tx.boardPermission.createMany({
				data: boardPerms.map((perm) => ({
					userId,
					boardId: perm.resourceId,
					role: perm.role as BoardRole,
					grantedBy,
				})),
			});
		}

		for (const update of updatedPermissions) {
			switch (update.type) {
				case 'group': {
					await tx.groupPermission.update({
						where: { dbId: update.dbId },
						data: { role: update.role as GroupRole, grantedBy },
					});

					break;
				}
				case 'category': {
					await tx.categoryPermission.update({
						where: { dbId: update.dbId },
						data: { role: update.role as CategoryRole, grantedBy },
					});

					break;
				}
				case 'board': {
					await tx.boardPermission.update({
						where: { dbId: update.dbId },
						data: { role: update.role as BoardRole, grantedBy },
					});

					break;
				}
			}
		}

		// A parent grant can make an older child grant redundant. Normalize after
		// applying all changes so this works regardless of grant order.
		const [userGroupPerms, userCategoryPerms, userBoardPerms] = await Promise.all([
			tx.groupPermission.findMany({
				where: { userId },
				select: { groupId: true, role: true },
			}),
			tx.categoryPermission.findMany({
				where: { userId },
				select: { dbId: true, categoryId: true, role: true, category: { select: { groupId: true } } },
			}),
			tx.boardPermission.findMany({
				where: { userId },
				select: { dbId: true, boardId: true, role: true, board: { select: { categoryId: true, category: { select: { groupId: true } } } } },
			}),
		]);

		const groupRoleMap = new Map(userGroupPerms.map((permission) => [permission.groupId, permission.role]));
		const categoryRoleMap = new Map(userCategoryPerms.map((permission) => [permission.categoryId, permission.role]));

		const redundantCategoryDbIds = userCategoryPerms
			.filter((permission) => {
				const groupRole = groupRoleMap.get(permission.category.groupId);
				return groupRole && getResourceRoleRank('category', groupRole) >= getResourceRoleRank('category', permission.role);
			})
			.map((permission) => permission.dbId);

		const redundantBoardDbIds = userBoardPerms
			.filter((permission) => {
				const categoryRole = categoryRoleMap.get(permission.board.categoryId);
				const groupRole = groupRoleMap.get(permission.board.category.groupId);
				const inheritedRank = Math.max(
					categoryRole ? getResourceRoleRank('board', categoryRole) : 0,
					groupRole ? getResourceRoleRank('board', groupRole) : 0,
				);

				return inheritedRank >= getResourceRoleRank('board', permission.role);
			})
			.map((permission) => permission.dbId);

		if (redundantCategoryDbIds.length > 0) {
			await tx.categoryPermission.deleteMany({ where: { dbId: { in: redundantCategoryDbIds } } });
			deletedCategoryPermissions = true;
		}

		if (redundantBoardDbIds.length > 0) {
			await tx.boardPermission.deleteMany({ where: { dbId: { in: redundantBoardDbIds } } });
			deletedBoardPermissions = true;
		}
	});

	if (newPermissions.some((p) => p.type === 'group') || updatedPermissions.some((p) => p.type === 'group')) await invalidateCacheForWrite(manager, 'groupPermission');
	if (newPermissions.some((p) => p.type === 'category') || updatedPermissions.some((p) => p.type === 'category') || deletedCategoryPermissions) await invalidateCacheForWrite(manager, 'categoryPermission');
	if (newPermissions.some((p) => p.type === 'board') || updatedPermissions.some((p) => p.type === 'board') || deletedBoardPermissions) await invalidateCacheForWrite(manager, 'boardPermission');

	await invalidateCacheForWrite(manager, 'user');
}

export async function collectResourcePermissions(resourceType: ResourceType, resourceId: string, manager: BoardsManager): Promise<ResourcePermissionsResult> {
	const usersWithAccess: Map<string, GrantedEntry[]> = new Map();

	switch (resourceType) {
		case 'board': {
			const board = await db(manager, 'board', 'findUnique', {
				where: { boardId: resourceId },
				select: {
					name: true,
					boardId: true,
					category: {
						select: {
							categoryId: true,
							name: true,
							group: { select: { groupId: true, name: true } },
						},
					},
				},
			});

			if (!board) return { usersWithAccess, resource: null };

			const categoryId = board.category.categoryId;
			const categoryName = board.category.name;
			const groupId = board.category.group.groupId;
			const groupName = board.category.group.name;

			const [boardPerms, categoryPerms, groupPerms] = await Promise.all([
				db(manager, 'boardPermission', 'findMany', {
					where: { boardId: board.boardId },
					select: { userId: true, role: true },
				}),
				db(manager, 'categoryPermission', 'findMany', {
					where: { categoryId },
					select: { userId: true, role: true },
				}),
				db(manager, 'groupPermission', 'findMany', {
					where: { groupId },
					select: { userId: true, role: true },
				}),
			]);

			for (const perm of boardPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'board',
					role: perm.role,
					resourceId: board.boardId,
					basedOnType: 'board',
					basedOnResourceId: board.boardId,
					basedOnResourceName: board.name,
				});
			}

			for (const perm of categoryPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'board',
					role: perm.role,
					resourceId: board.boardId,
					basedOnType: 'category',
					basedOnResourceId: categoryId,
					basedOnResourceName: categoryName,
				});
			}

			for (const perm of groupPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'board',
					role: perm.role,
					resourceId: board.boardId,
					basedOnType: 'group',
					basedOnResourceId: groupId,
					basedOnResourceName: groupName,
				});
			}

			return {
				usersWithAccess,
				resource: { id: board.boardId, name: board.name },
			};
		}
		case 'category': {
			const category = await db(manager, 'category', 'findUnique', {
				where: { categoryId: resourceId },
				select: {
					categoryId: true,
					name: true,
					group: { select: { groupId: true, name: true } },
				},
			});

			if (!category) return { usersWithAccess, resource: null };

			const groupId = category.group.groupId;
			const groupName = category.group.name;

			const [categoryPerms, groupPerms] = await Promise.all([
				db(manager, 'categoryPermission', 'findMany', {
					where: { categoryId: category.categoryId },
					select: { userId: true, role: true },
				}),
				db(manager, 'groupPermission', 'findMany', {
					where: { groupId },
					select: { userId: true, role: true },
				}),
			]);

			for (const perm of categoryPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'category',
					role: perm.role,
					resourceId: category.categoryId,
					basedOnType: 'category',
					basedOnResourceId: category.categoryId,
					basedOnResourceName: category.name,
				});
			}

			for (const perm of groupPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'category',
					role: perm.role,
					resourceId: category.categoryId,
					basedOnType: 'group',
					basedOnResourceId: groupId,
					basedOnResourceName: groupName,
				});
			}

			return {
				usersWithAccess,
				resource: { id: category.categoryId, name: category.name },
			};
		}
		case 'group': {
			const group = await db(manager, 'group', 'findUnique', {
				where: { groupId: resourceId },
				select: { groupId: true, name: true },
			});

			if (!group) return { usersWithAccess, resource: null };

			const groupPerms = await db(manager, 'groupPermission', 'findMany', {
				where: { groupId: group.groupId },
				select: { userId: true, role: true },
			});

			for (const perm of groupPerms || []) {
				addPermission(usersWithAccess, perm.userId, {
					type: 'group',
					role: perm.role,
					resourceId: group.groupId,
					basedOnType: 'group',
					basedOnResourceId: group.groupId,
					basedOnResourceName: group.name,
				});
			}

			return {
				usersWithAccess,
				resource: { id: group.groupId, name: group.name },
			};
		}
	}

	return { usersWithAccess, resource: null };
}

export async function getPermissionCheckData<T extends ResourceType>(resourceType: T, resourceId: string, manager: BoardsManager): Promise<PermissionCheckData<T> | null> {
	switch (resourceType) {
		case 'board': {
			const board = await db(manager, 'board', 'findUnique', {
				where: { boardId: resourceId },
				select: {
					boardId: true,
					category: {
						select: {
							categoryId: true,
							group: { select: { groupId: true } },
						},
					},
				},
			});

			if (!board) return null;

			return {
				type: 'board',
				data: {
					boardId: board.boardId,
					categoryId: board.category.categoryId,
					groupId: board.category.group.groupId,
				},
			} as PermissionCheckData<T>;
		}
		case 'category': {
			const category = await db(manager, 'category', 'findUnique', {
				where: { categoryId: resourceId },
				select: { categoryId: true, group: { select: { groupId: true } } },
			});

			if (!category) return null;

			return {
				type: 'category',
				data: { categoryId: category.categoryId, groupId: category.group.groupId },
			} as PermissionCheckData<T>;
		}
		case 'group': {
			return { type: 'group', data: { groupId: resourceId } } as PermissionCheckData<T>;
		}
	}

	return null;
}
