import { PermissionGrantResult, UserRole, GlobalRole, ResourceType, AccessLevel, GlobalResourceType, ResourceReturnEnum, ResourceTypeGeneric, GrantedRoles, GrantedRole } from '../types';
import { getBoardResourceId, getCategoryResourceId, getGroupResourceId, securityUtils } from '../modules/functions';
import { BoardRole, CategoryRole, GroupRole } from '@prisma/client';
import { GrantPermissionsRequest } from '../routes/permissions';
import { DBUserPartialType } from './vars';
import { BoardsManager } from '../index';
import config from '../core/config';
import { db } from '../core/prisma';
import crypto from 'crypto';

// Permission hierarchy levels (higher number = more permissions)
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
	return config.developers.includes(securityUtils.decrypt(email));
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
	if (!role) return null;

	switch (resource.type) {
		case 'board': {
			if (PermissionHierarchy[role] >= PermissionHierarchy[BoardRole.BoardCollaborator]) return 'write';
			if (PermissionHierarchy[role] >= PermissionHierarchy[BoardRole.BoardViewer]) return 'read';
			break;
		}
		case 'category': {
			if (PermissionHierarchy[role] >= PermissionHierarchy[CategoryRole.CategoryAdmin]) return 'admin';
			if (PermissionHierarchy[role] >= PermissionHierarchy[CategoryRole.CategoryManager]) return 'manage';
			if (PermissionHierarchy[role] >= PermissionHierarchy[CategoryRole.CategoryCollaborator]) return 'write';
			if (PermissionHierarchy[role] >= PermissionHierarchy[CategoryRole.CategoryViewer]) return 'read';
			break;
		}
		case 'group': {
			if (PermissionHierarchy[role] >= PermissionHierarchy[GroupRole.GroupAdmin]) return 'admin';
			if (PermissionHierarchy[role] >= PermissionHierarchy[GroupRole.GroupManager]) return 'manage';
			if (PermissionHierarchy[role] >= PermissionHierarchy[GroupRole.GroupCollaborator]) return 'write';
			if (PermissionHierarchy[role] >= PermissionHierarchy[GroupRole.GroupViewer]) return 'read';
			break;
		}
	}

	return null;
}

export function canView<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const role = userHighestRole || getUserHighestRole(DBUser, resource);
	if (!role) return false;

	let targetPermission: UserRole | null = null;
	switch (resource.type) {
		case 'global': targetPermission = GlobalRole.Developer; break;
		case 'board': targetPermission = BoardRole.BoardViewer; break;
		case 'category': targetPermission = CategoryRole.CategoryViewer; break;
		case 'group': targetPermission = GroupRole.GroupViewer; break;
	}

	return PermissionHierarchy[role] >= PermissionHierarchy[targetPermission];
}

export function canManage<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const role = userHighestRole || getUserHighestRole(DBUser, resource);
	if (!role) return false;

	let targetPermission: UserRole | null = null;
	switch (resource.type) {
		case 'global': targetPermission = GlobalRole.Developer; break;
		case 'board': targetPermission = CategoryRole.CategoryManager; break;
		case 'category': targetPermission = GroupRole.GroupManager; break;
		case 'group': targetPermission = GlobalRole.Developer; break;
	}

	return PermissionHierarchy[role] >= PermissionHierarchy[targetPermission];
}

export function canManagePermissions<A extends GlobalResourceType>(DBUser: DBUserPartialType, resource: ResourceTypeGeneric<A>, userHighestRole?: UserRole): boolean {
	const role = userHighestRole || getUserHighestRole(DBUser, resource);
	if (!role) return false;

	let targetPermission: UserRole | null = null;
	switch (resource.type) {
		case 'global': targetPermission = GlobalRole.Developer; break;
		case 'board': targetPermission = CategoryRole.CategoryAdmin; break;
		case 'category': targetPermission = GroupRole.GroupAdmin; break;
		case 'group': targetPermission = GlobalRole.Developer; break;
	}

	return PermissionHierarchy[role] >= PermissionHierarchy[targetPermission];
}

export function isValidRoleForResource(role: string, resourceType: ResourceType): boolean {
	switch (resourceType) {
		case 'group': return Object.values(GroupRole).includes(role as GroupRole);
		case 'category': return Object.values(CategoryRole).includes(role as CategoryRole);
		case 'board': return Object.values(BoardRole).includes(role as BoardRole);
		default: return false;
	}
}

export async function hasAccessToBoard(manager: BoardsManager, DBUser: DBUserPartialType, boardId: string): Promise<{ hasAccess: boolean; canEdit: boolean; role?: UserRole }> {
	if (isDeveloper(DBUser.email)) return { hasAccess: true, canEdit: true, role: GlobalRole.Developer };

	const boardPerm = DBUser.boardPermissions.find((bp) => bp.boardId === boardId);
	if (boardPerm) return {
		hasAccess: true,
		canEdit: boardPerm.role !== BoardRole.BoardViewer,
		role: boardPerm.role,
	};

	const board = await db(manager, 'board', 'findUnique', { where: { boardId }, include: { category: true } });
	if (!board) return { hasAccess: false, canEdit: false };

	const categoryPerm = DBUser.categoryPermissions.find((cp) => cp.categoryId === board.categoryId);
	if (categoryPerm) return {
		hasAccess: true,
		canEdit: categoryPerm.role !== CategoryRole.CategoryViewer,
		role: categoryPerm.role,
	};

	const groupPerm = DBUser.groupPermissions.find((gp) => gp.groupId === board.category.groupId);
	if (groupPerm) return {
		hasAccess: true,
		canEdit: groupPerm.role !== GroupRole.GroupViewer,
		role: groupPerm.role,
	};

	return { hasAccess: false, canEdit: false };
}

export function generateInviteCode(): string {
	return crypto.randomBytes(16).toString('hex');
}

export async function processPermissionGrants(manager: BoardsManager, request: GrantPermissionsRequest): Promise<PermissionGrantResult> {
	const { userId, groupIds, categoryIds, boardIds, groupRole, categoryRole, boardRole } = request;

	const newPermissions: GrantedRoles = [];
	const updatedPermissions: (GrantedRole & { dbId: string })[] = [];

	if (groupIds && groupIds.length > 0 && groupRole) {
		for (const groupId of groupIds) {
			const existing = await db(manager, 'groupPermission', 'findFirst', { where: { userId, groupId } });

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
		for (const categoryId of categoryIds) {
			const existing = await db(manager, 'categoryPermission', 'findFirst', { where: { userId, categoryId } });

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
		for (const boardId of boardIds) {
			const existing = await db(manager, 'boardPermission', 'findFirst', { where: { userId, boardId } });

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
}
