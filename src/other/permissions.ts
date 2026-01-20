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

export function getAccessLevel<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): AccessLevel | null {
	const role = userHighestRole || getUserHighestRole(DBUser, resource);
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

	switch (resource.type) {
		case 'board': {
			if (role === BoardRole.BoardViewer) return 'read';
			if (role === BoardRole.BoardCollaborator) return 'write';

			if (role === CategoryRole.CategoryViewer) return 'read';
			if (role === CategoryRole.CategoryCollaborator) return 'write';
			if (role === CategoryRole.CategoryManager) return 'manage';
			if (role === CategoryRole.CategoryAdmin) return 'admin';

			if (role === GroupRole.GroupViewer) return 'read';
			if (role === GroupRole.GroupCollaborator) return 'write';
			if (role === GroupRole.GroupManager) return 'manage';
			if (role === GroupRole.GroupAdmin) return 'admin';

			if (role === GlobalRole.Developer) return 'admin';
			break;
		}
		case 'category': {
			if (role === CategoryRole.CategoryViewer) return 'read';
			if (role === CategoryRole.CategoryCollaborator) return 'write';
			if (role === CategoryRole.CategoryManager) return 'manage';
			if (role === CategoryRole.CategoryAdmin) return 'admin';

			if (role === GroupRole.GroupViewer) return 'read';
			if (role === GroupRole.GroupCollaborator) return 'write';
			if (role === GroupRole.GroupManager) return 'manage';
			if (role === GroupRole.GroupAdmin) return 'admin';

			if (role === GlobalRole.Developer) return 'admin';
			break;
		}
		case 'group': {
			if (role === GroupRole.GroupViewer) return 'read';
			if (role === GroupRole.GroupCollaborator) return 'write';
			if (role === GroupRole.GroupManager) return 'manage';
			if (role === GroupRole.GroupAdmin) return 'admin';

			if (role === GlobalRole.Developer) return 'admin';
			break;
		}
	}

	return null;
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

	const newPermissions: GrantedRoles = [];
	const updatedPermissions: (GrantedRole & { dbId: string })[] = [];

	const [existingGroupPerms, existingCategoryPerms, existingBoardPerms] = await Promise.all([
		groupIds && groupIds.length > 0 && groupRole ? db(manager, 'groupPermission', 'findMany', { where: { userId, groupId: { in: groupIds } } }) : Promise.resolve([]),
		categoryIds && categoryIds.length > 0 && categoryRole ? db(manager, 'categoryPermission', 'findMany', { where: { userId, categoryId: { in: categoryIds } } }) : Promise.resolve([]),
		boardIds && boardIds.length > 0 && boardRole ? db(manager, 'boardPermission', 'findMany', { where: { userId, boardId: { in: boardIds } } }) : Promise.resolve([]),
	]);

	if (groupIds && groupIds.length > 0 && groupRole) {
		const existingMap = new Map((existingGroupPerms || []).map((p) => [p.groupId, p]));

		for (const groupId of groupIds) {
			const existing = existingMap.get(groupId);

			if (!existing) newPermissions.push({ type: 'group', resourceId: groupId, role: groupRole });
			else {
				const existingHierarchy = PermissionHierarchy[existing.role];
				const newHierarchy = PermissionHierarchy[groupRole];

				if (newHierarchy > existingHierarchy) {
					updatedPermissions.push({
						type: 'group',
						resourceId: groupId,
						role: groupRole,
						dbId: existing.dbId,
					});
				}
			}
		}
	}

	if (categoryIds && categoryIds.length > 0 && categoryRole) {
		const existingMap = new Map((existingCategoryPerms || []).map((p) => [p.categoryId, p]));

		for (const categoryId of categoryIds) {
			const existing = existingMap.get(categoryId);

			if (!existing) newPermissions.push({ type: 'category', resourceId: categoryId, role: categoryRole });
			else {
				const existingHierarchy = PermissionHierarchy[existing.role];
				const newHierarchy = PermissionHierarchy[categoryRole];

				if (newHierarchy > existingHierarchy) {
					updatedPermissions.push({
						type: 'category',
						resourceId: categoryId,
						role: categoryRole,
						dbId: existing.dbId,
					});
				}
			}
		}
	}

	if (boardIds && boardIds.length > 0 && boardRole) {
		const existingMap = new Map((existingBoardPerms || []).map((p) => [p.boardId, p]));

		for (const boardId of boardIds) {
			const existing = existingMap.get(boardId);

			if (!existing) newPermissions.push({ type: 'board', resourceId: boardId, role: boardRole });
			else {
				const existingHierarchy = PermissionHierarchy[existing.role];
				const newHierarchy = PermissionHierarchy[boardRole];

				if (newHierarchy > existingHierarchy) {
					updatedPermissions.push({
						type: 'board',
						resourceId: boardId,
						role: boardRole,
						dbId: existing.dbId,
					});
				}
			}
		}
	}

	return { newPermissions, updatedPermissions };
}

export async function applyPermissionGrants(manager: BoardsManager, result: PermissionGrantResult, grantedBy: string, userId: string): Promise<void> {
	const { newPermissions, updatedPermissions } = result;

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
	});

	if (newPermissions.some((p) => p.type === 'group') || updatedPermissions.some((p) => p.type === 'group')) await invalidateCacheForWrite(manager, 'groupPermission');
	if (newPermissions.some((p) => p.type === 'category') || updatedPermissions.some((p) => p.type === 'category')) await invalidateCacheForWrite(manager, 'categoryPermission');
	if (newPermissions.some((p) => p.type === 'board') || updatedPermissions.some((p) => p.type === 'board')) await invalidateCacheForWrite(manager, 'boardPermission');

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
}
