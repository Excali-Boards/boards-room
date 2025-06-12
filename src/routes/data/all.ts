import { json, makeRoute } from '../../classes/routes';
import { db } from '../../modules/prisma';
import manager from '../../index';

export default [
	makeRoute({
		path: '/data/all',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const allowedBoardIds = c.var.privileged
				? undefined
				: [
					...c.var.DBUser.boardPermissions.map((p) => p.boardId),
					...c.var.DBUser.ownedBoards.map((b) => b.boardId),
				];

			const DBGroups = await db(manager, 'group', 'findMany', {
				where: c.var.privileged
					? undefined
					: {
						categories: {
							some: {
								boards: {
									some: {
										boardId: {
											in: allowedBoardIds,
										},
									},
								},
							},
						},
					},
				include: {
					categories: {
						include: {
							boards: true,
						},
					},
				},
			}) || [];

			const filteredGroups = DBGroups
				.sort((a, b) => {
					if (c.var.DBUser.mainGroupId === a.groupId) return -1;
					if (c.var.DBUser.mainGroupId === b.groupId) return 1;
					return a.index - b.index;
				})
				.map((group) => ({
					id: group.groupId,
					name: group.name,
					index: group.index,
					categories: group.categories
						.sort((a, b) => a.index - b.index)
						.filter((category) =>
							c.var.privileged ||
							category.boards.some((board) => allowedBoardIds?.includes(board.boardId)),
						)
						.map((category) => ({
							id: category.categoryId,
							name: category.name,
							index: category.index,
							boards: category.boards
								.sort((a, b) => a.index - b.index)
								.filter((board) => c.var.privileged || allowedBoardIds?.includes(board.boardId))
								.map((board) => ({
									id: board.boardId,
									name: board.name,
									index: board.index,
								})),
						})),
				}));

			if (!c.var.privileged && filteredGroups.every((g) => g.categories.length === 0)) {
				return json(c, 403, {
					error: 'You do not have access to any boards.',
				});
			}

			return json(c, 200, {
				data: {
					isAdmin: c.var.privileged,
					list: filteredGroups,
				},
			});
		},
	}),
];
