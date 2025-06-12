import { json, makeRoute } from '../classes/routes';
import { parseZodError } from '../modules/utils';
import { db } from '../modules/prisma';
import manager from '../index';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/utils/resolve-board',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = resolveSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const { groupName, categoryName, boardName } = isValid.data;
			const DBBoard = await db(manager, 'board', 'findFirst', {
				include: { category: { include: { group: true } }, boardPermission: true },
				where: {
					name: { mode: 'insensitive', equals: boardName },
					category: {
						name: { mode: 'insensitive', equals: categoryName },
						group: {
							name: { mode: 'insensitive', equals: groupName },
						},
					},
				},
			});
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const canAccess = c.var.DBUser.isBoardsAdmin || c.var.isDev || DBBoard.ownerId === c.var.DBUser.userId || !!DBBoard.boardPermission?.find((b) => b.boardId === DBBoard.boardId);
			if (!canAccess) return json(c, 403, { error: 'You do not have access to this board.' });

			return json(c, 200, {
				data: {
					boardId: DBBoard.boardId,
					groupId: DBBoard.category.groupId,
					categoryId: DBBoard.category.categoryId,
				},
			});
		},
	}),
	makeRoute({
		path: '/utils/purge-unused',
		method: 'POST',
		enabled: true,
		auth: true,
		devOnly: true,

		handler: async (c) => {
			const boardId = c.req.query('boardId');
			const result = await manager.files.deleteUnusedFiles(boardId);

			return json(c, result.status, 'data' in result ? { data: result.data } : { error: result.error });
		},
	}),
];

const urlString = z.string().transform((val) => decodeURIComponent(val));

export const resolveSchema = z.object({
	groupName: urlString,
	categoryName: urlString,
	boardName: urlString,
});
