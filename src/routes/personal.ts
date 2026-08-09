import { compressionUtils, parseZodError, securityUtils } from '../modules/functions.js';
import { PersonalWorkspaceArgs, PersonalWorkspaceType } from '../other/vars.js';
import config, { boardObject } from '../core/config.js';
import { json, makeRoute } from '../services/routes.js';
import manager from '../index.js';

export const canAccessWorkspace = (isDev: boolean, currentUserId: string, ownerId: string) => {
	return isDev || currentUserId === ownerId;
};

export const mapWorkspace = (workspace: PersonalWorkspaceType) => ({
	id: workspace.groupId,
	owner: workspace.user,
	categories: workspace.categories.map((category) => ({
		id: category.backingCategoryId,
		name: category.name,
		boards: category.boards.map(({ board }) => ({
			...board,
			id: board.boardId,
			categoryId: category.backingCategoryId,
		})),
	})),
});

export default [
	makeRoute({
		path: '/personal/:userId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			if (!canAccessWorkspace(c.var.isDev, c.var.DBUser.userId, userId)) return json(c, 403, { error: 'You do not have access to this personal workspace.' });

			const workspace = await manager.prisma.personalWorkspace.findUnique({
				where: { userId },
				...PersonalWorkspaceArgs,
			});

			if (!workspace) return json(c, 404, { error: 'Personal workspace not found.' });

			return json(c, 200, {
				data: mapWorkspace(workspace),
			});
		},
	}),
	makeRoute({
		path: '/personal/:userId/categories/:categoryId/boards',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			const categoryId = c.req.param('categoryId');
			if (!canAccessWorkspace(c.var.isDev, c.var.DBUser.userId, userId)) return json(c, 403, { error: 'You do not have access to this personal workspace.' });

			const category = await manager.prisma.personalCategory.findFirst({
				where: {
					workspace: { userId },
					OR: [{ categoryId }, { backingCategoryId: categoryId }],
				},
				select: {
					backingCategoryId: true,
					boards: {
						orderBy: { board: { index: 'asc' } },
						select: {
							board: {
								select: {
									boardId: true,
									name: true,
									type: true,
									index: true,
									totalSizeBytes: true,
									scheduledForDeletion: true,
								},
							},
						},
					},
				},
			});

			if (!category) return json(c, 404, { error: 'Personal category not found.' });

			return json(c, 200, {
				data: category.boards.map(({ board }) => ({
					...board,
					id: board.boardId,
					categoryId: category.backingCategoryId,
				})),
			});
		},
	}),
	makeRoute({
		path: '/personal/:userId/categories/:categoryId/boards',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			const categoryId = c.req.param('categoryId');
			if (!canAccessWorkspace(c.var.isDev, c.var.DBUser.userId, userId) || (!config.personalBoardsEnabled && !c.var.isDev)) return json(c, 403, { error: 'You do not have permission to create personal boards.' });

			const isValid = boardObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const category = await manager.prisma.personalCategory.findFirst({
				where: {
					workspace: { userId },
					OR: [{ categoryId }, { backingCategoryId: categoryId }],
				},
				select: {
					dbId: true,
					backingCategoryId: true,
					workspaceId: true,
					workspace: { select: { groupId: true } },
				},
			});

			if (!category) return json(c, 404, { error: 'Personal category not found.' });

			const boardId = securityUtils.randomString(12);
			const index = await manager.prisma.board.aggregate({
				where: { categoryId: category.backingCategoryId },
				_max: { index: true },
			});

			await manager.prisma.$transaction([
				manager.prisma.board.create({
					data: {
						boardId,
						name: isValid.data.name,
						type: isValid.data.type,
						categoryId: category.backingCategoryId,
						index: (index._max.index ?? -1) + 1,
					},
				}),
				manager.prisma.personalBoard.create({
					data: {
						boardId,
						workspaceId: category.workspaceId,
						categoryId: category.dbId,
					},
				}),
			]);

			const uploaded = await manager.files.uploadBoardFile(boardId, compressionUtils.compressAndEncrypt(isValid.data.type === 'Excalidraw' ? [] : {}), 'application/octet-stream').catch(() => null);
			if (!uploaded) {
				await manager.prisma.board.delete({ where: { boardId } }).catch(() => null);
				return json(c, 500, { error: 'Failed to initialize personal board.' });
			}

			return json(c, 200, {
				data: {
					groupId: category.workspace.groupId,
					categoryId: category.backingCategoryId,
					boardId,
				},
			});
		},
	}),
	makeRoute({
		path: '/personal/:userId/categories/:categoryId/boards/:boardId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			const categoryId = c.req.param('categoryId');
			const boardId = c.req.param('boardId');
			if (!canAccessWorkspace(c.var.isDev, c.var.DBUser.userId, userId)) return json(c, 403, { error: 'You do not have access to this personal workspace.' });

			const board = await manager.prisma.board.findFirst({
				where: {
					boardId,
					personalBoard: {
						workspace: { userId },
						category: { backingCategoryId: categoryId },
					},
				},
				select: {
					boardId: true,
					name: true,
					type: true,
					index: true,
					totalSizeBytes: true,
					scheduledForDeletion: true,
					category: {
						select: {
							categoryId: true,
							name: true,
							index: true,
							group: {
								select: {
									groupId: true,
									name: true,
									index: true,
								},
							},
						},
					},
				},
			});

			if (!board) return json(c, 404, { error: 'Personal board not found.' });

			return json(c, 200, {
				data: {
					isDev: c.var.isDev,
					group: {
						id: board.category.group.groupId,
						name: board.category.group.name,
						index: board.category.group.index,
						accessLevel: 'admin',
					},
					category: {
						id: board.category.categoryId,
						name: board.category.name,
						index: board.category.index,
						accessLevel: 'admin',
					},
					board: {
						id: board.boardId,
						name: board.name,
						type: board.type,
						index: board.index,
						accessLevel: 'admin',
						totalSizeBytes: board.totalSizeBytes,
						dataUrl: `${config.s3.endpoint}/${config.s3.bucket}/boards/${board.boardId}.bin`,
						scheduledForDeletion: board.scheduledForDeletion,
						hasFlashcards: false,
						files: [],
					},
				},
			});
		},
	}),
];
