import { getAccessLevel, getUserHighestRole } from '../other/permissions.js';
import { json, makeRoute } from '../services/routes.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';

export default [
	makeRoute({
		path: '/all',
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
							groupId: true,
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
									flashcardDeck: { select: { deckId: true } },
								},
							},
						},
					},
				},
			}) || [];

			const groupRoles = new Map<string, ReturnType<typeof getUserHighestRole>>();
			const categoryRoles = new Map<string, ReturnType<typeof getUserHighestRole>>();
			const boardRoles = new Map<string, ReturnType<typeof getUserHighestRole>>();

			for (const group of DBGroups) {
				const groupRole = getUserHighestRole(c.var.DBUser, { type: 'group', data: { groupId: group.groupId } });
				groupRoles.set(group.groupId, groupRole);

				for (const category of group.categories) {
					const categoryRole = getUserHighestRole(c.var.DBUser, { type: 'category', data: { groupId: group.groupId, categoryId: category.categoryId } });
					categoryRoles.set(category.categoryId, categoryRole);

					for (const board of category.boards) {
						const boardRole = getUserHighestRole(c.var.DBUser, { type: 'board', data: { groupId: group.groupId, categoryId: category.categoryId, boardId: board.boardId } });
						boardRoles.set(board.boardId, boardRole);
					}
				}
			}

			return json(c, 200, {
				data: DBGroups.map((group) => ({
					id: group.groupId,
					name: group.name,
					index: group.index,
					accessLevel: getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId: group.groupId } }, groupRoles.get(group.groupId) || undefined),
					categories: group.categories.map((category) => ({
						id: category.categoryId,
						name: category.name,
						index: category.index,
						accessLevel: getAccessLevel(c.var.DBUser, { type: 'category', data: { groupId: group.groupId, categoryId: category.categoryId } }, categoryRoles.get(category.categoryId) || undefined),
						boards: category.boards.map((board) => ({
							id: board.boardId,
							name: board.name,
							index: board.index,
							accessLevel: getAccessLevel(c.var.DBUser, { type: 'board', data: { groupId: group.groupId, categoryId: category.categoryId, boardId: board.boardId } }, boardRoles.get(board.boardId) || undefined),
							totalSizeBytes: board.totalSizeBytes,
							scheduledForDeletion: board.scheduledForDeletion,
							hasFlashcards: board.flashcardDeck !== null,
						})).sort((a, b) => a.index - b.index),
					})).sort((a, b) => a.index - b.index),
				})).sort((a, b) => a.index - b.index),
			});
		},
	}),
];
