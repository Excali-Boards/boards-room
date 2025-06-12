import { BoardPermission, BoardPermissionType } from '@prisma/client';
import { parseZodError, securityUtils } from '../modules/utils';
import { json, makeRoute } from '../classes/routes';
import config from '../modules/config';
import { db } from '../modules/prisma';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/admin/rooms',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'Forbidden.' });

			const rooms = [...manager.socket.roomData.values()].map((room) => ({
				boardId: room.boardId,
				elements: room.elements.length,
				collaborators: [...room.collaborators.values()].map((collaborator) => ({
					id: collaborator.id,
					socketId: collaborator.socketId,
					username: collaborator.username,
					avatarUrl: collaborator.avatarUrl,
				}))
					.filter((collaborator) => collaborator.id && collaborator.socketId && collaborator.username && collaborator.avatarUrl)
					.filter((collaborator, index, self) => self.findIndex((c) => c.id === collaborator.id) === index),
			}));

			return json(c, 200, { data: rooms });
		},
	}),
	makeRoute({
		path: '/admin/permissions',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'Forbidden.' });

			const parsed = updatePermissionsSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return json(c, 400, { error: parseZodError(parsed.error) });

			const { userId, isBoardsAdmin, permissions } = parsed.data;

			const userToUpdate = await db(manager, 'user', 'findUnique', { where: { userId }, include: { boardPermissions: true } });
			if (!userToUpdate) return json(c, 404, { error: 'User not found.' });

			if (typeof isBoardsAdmin === 'boolean') {
				const isDev = config.developers.includes(securityUtils.decrypt(c.var.DBUser.email));
				if (!isDev) return json(c, 403, { error: 'Not allowed to change isBoardsAdmin.' });

				await db(manager, 'user', 'update', {
					where: { userId },
					data: { isBoardsAdmin },
					select: { userId: true },
				});
			}

			if (userToUpdate.isBoardsAdmin && !c.var.DBUser.isBoardsAdmin) return json(c, 403, { error: 'Cannot modify permissions of admin users.' });

			if (permissions) {
				const existingPerms = userToUpdate.boardPermissions;

				const newPermMap = new Map(permissions.map((p) => [`${p.boardId}`, p.permissionType]));
				const oldPermMap = new Map(existingPerms.map((p) => [`${p.boardId}`, p.permissionType]));

				const toAdd: Omit<BoardPermission, 'dbId' | 'userId'>[] = [];
				const toUpdate: Omit<BoardPermission, 'dbId' | 'userId'>[] = [];
				const toDelete: string[] = [];

				for (const [boardId, oldType] of oldPermMap.entries()) {
					const newType = newPermMap.get(boardId);
					if (!newType) toDelete.push(boardId);
					else if (newType !== oldType) toUpdate.push({ boardId, permissionType: newType });
				}

				for (const [boardId, newType] of newPermMap.entries()) {
					if (!oldPermMap.has(boardId)) toAdd.push({ boardId, permissionType: newType });
				}

				await Promise.all([
					...toDelete.map((boardId) =>
						db(manager, 'boardPermission', 'delete', {
							where: { userId_boardId: { userId, boardId } },
						}).catch(() => null),
					),
					...toUpdate.map((p) =>
						db(manager, 'boardPermission', 'update', {
							where: { userId_boardId: { userId, boardId: p.boardId } },
							data: { permissionType: p.permissionType },
						}).catch(() => null),
					),
					...toAdd.map((p) =>
						db(manager, 'boardPermission', 'create', {
							data: { userId, ...p },
						}).catch(() => null),
					),
				]);
			}

			return json(c, 200, { data: 'User permissions updated.' });
		},
	}),
];

export const permissionsSchema = z.array(
	z.object({
		boardId: z.string(),
		permissionType: z.nativeEnum(BoardPermissionType),
	}),
);

export const updatePermissionsSchema = z.object({
	userId: z.string(),
	isBoardsAdmin: z.boolean().optional(),
	permissions: permissionsSchema.optional(),
});
