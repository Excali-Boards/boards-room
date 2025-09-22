import { getAccessLevel } from '../../other/permissions';
import { json, makeRoute } from '../../services/routes';
import { db } from '../../core/prisma';
import manager from '../../index';

export default [
	makeRoute({
		path: '/data/all',
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
								select: {
									boardId: true,
									name: true,
									index: true,
									totalSizeBytes: true,
									scheduledForDeletion: true,
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, {
				data: DBGroups.map((group) => ({
					id: group.groupId,
					name: group.name,
					index: group.index,
					accessLevel: getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId: group.groupId } }),
					categories: group.categories.map((category) => ({
						id: category.categoryId,
						name: category.name,
						index: category.index,
						accessLevel: getAccessLevel(c.var.DBUser, { type: 'category', data: { groupId: group.groupId, categoryId: category.categoryId } }),
						boards: category.boards.map((board) => ({
							id: board.boardId,
							name: board.name,
							index: board.index,
							accessLevel: getAccessLevel(c.var.DBUser, { type: 'board', data: { groupId: group.groupId, categoryId: category.categoryId, boardId: board.boardId } }),
							totalSizeBytes: board.totalSizeBytes,
							scheduledForDeletion: board.scheduledForDeletion,
						})).sort((a, b) => a.index - b.index),
					})).sort((a, b) => a.index - b.index),
				})).sort((a, b) => a.index - b.index),
			});
		},
	}),
];
