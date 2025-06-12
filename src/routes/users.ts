import { parseZodError, securityUtils } from '../modules/utils';
import config, { nameObject } from '../modules/config';
import { json, makeRoute } from '../classes/routes';
import { Platforms } from '@prisma/client';
import { db } from '../modules/prisma';
import { TSUser } from '../types';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/users',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'Forbidden.' });
			const DBUsers = await db(manager, 'user', 'findMany', {
				select: {
					userId: true,
					email: true,
					avatarUrl: true,
					displayName: true,
					mainLoginType: true,
					isBoardsAdmin: true,
					mainGroupId: true,

					ownedBoards: {
						select: {
							boardId: true,
							name: true,
						},
					},
					boardPermissions: {
						select: {
							boardId: true,
							permissionType: true,
						},
					},
				},
				where: {},
			}) || [];

			return json(c, 200, {
				data: DBUsers.map((user) => ({
					id: user.userId,
					email: user.email,
					avatarUrl: user.avatarUrl,
					displayName: user.displayName,
					mainLoginType: user.mainLoginType,
					mainGroupId: user.mainGroupId,

					isDev: config.developers.includes(securityUtils.decrypt(user.email)),
					isBoardsAdmin: user.isBoardsAdmin,

					ownedBoards: user.ownedBoards.map((board) => ({
						boardId: board.boardId,
						boardName: board.name,
					})),
					boardPermissions: user.boardPermissions.map((perm) => ({
						boardId: perm.boardId,
						permissionType: perm.permissionType,
					})),
				})),
			});
		},
	}),
	makeRoute({
		path: '/users/current',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const full = c.req.query('full') === 'true';

			const DBUser = (full ? await db(manager, 'user', 'findUnique', { where: { userId: c.var.DBUser.userId }, include: { ownedBoards: true, boardPermissions: true, loginMethods: true } }) : c.var.DBUser) as TSUser;
			if (!DBUser) return json(c, 404, { error: 'User not found.' });

			return json(c, 200, {
				data: {
					id: DBUser.userId,
					email: DBUser.email,
					avatarUrl: DBUser.avatarUrl,
					displayName: DBUser.displayName,
					mainLoginType: DBUser.mainLoginType,
					mainGroupId: DBUser.mainGroupId,

					isDev: c.var.isDev,
					isBoardsAdmin: DBUser.isBoardsAdmin,

					loginMethods: full && 'loginMethods' in DBUser ? DBUser.loginMethods.map((method) => ({
						email: method.platformEmail,
						platform: method.platform,
					})) : undefined,

					ownedBoards: DBUser.ownedBoards.map((board) => ({
						boardId: board.boardId,
						boardName: board.name,
					})),
					boardPermissions: DBUser.boardPermissions.map((perm) => ({
						boardId: perm.boardId,
						permissionType: perm.permissionType,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/users/change-main-platform',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'Forbidden.' });

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const newMainPlatform = isValid.data.name;

			const platformInfo = await db(manager, 'loginMethod', 'findFirst', { where: { userId: c.var.DBUser.userId, platform: newMainPlatform as Platforms } });
			if (!platformInfo) return json(c, 400, { error: 'You must connect to the platform you want to set as main first.' });

			await db(manager, 'user', 'update', {
				where: { userId: c.var.DBUser.userId },
				select: { userId: true },
				data: {
					email: platformInfo.platformEmail,
					mainLoginType: newMainPlatform as Platforms,
					loginMethods: {
						deleteMany: {
							platform: platformInfo.platform,
							platformEmail: platformInfo.platformEmail,
						},
						create: {
							platform: platformInfo.platform,
							platformEmail: platformInfo.platformEmail,
						},
					},
				},
			});

			return json(c, 200, { data: 'Successfully changed main platform.' });
		},
	}),
	makeRoute({
		path: '/users/change-main-group',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!c.var.privileged) return json(c, 403, { error: 'Forbidden.' });

			const isValid = z.object({ groupId: z.string().nullable() }).safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const DBGroup = isValid.data.groupId ? await db(manager, 'group', 'findUnique', { where: { groupId: isValid.data.groupId } }) : null;
			if (!DBGroup && isValid.data.groupId) return json(c, 404, { error: 'Group not found.' });

			await db(manager, 'user', 'update', {
				where: { userId: c.var.DBUser.userId },
				data: { mainGroupId: isValid.data.groupId },
			});

			return json(c, 200, { data: 'Successfully changed default group.' });
		},
	}),
];
