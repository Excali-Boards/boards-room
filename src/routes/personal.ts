import { compressionUtils, parseZodError, securityUtils } from '../modules/functions.js';
import { PersonalWorkspaceArgs, PersonalWorkspaceType } from '../other/vars.js';
import config, { boardObject, nameObject } from '../core/config.js';
import { json, makeRoute } from '../services/routes.js';
import manager from '../index.js';

const personalGroupName = 'Personal Boards';

export const canAccessWorkspace = (isDev: boolean, currentUserId: string, ownerId: string) => {
	return isDev || currentUserId === ownerId;
};

export const mapWorkspace = (workspace: PersonalWorkspaceType) => ({
	id: workspace.groupId,
	owner: workspace.owner,
	categories: workspace.categories.map((category) => ({
		id: category.categoryId,
		name: category.name,
		boards: category.boards.map((board) => ({
			...board,
			id: board.boardId,
			categoryId: category.categoryId,
		})),
	})),
});

export async function ensurePersonalWorkspace(userId: string) {
	const user = await manager.prisma.user.findUnique({
		where: { userId },
		select: { userId: true },
	});
	if (!user) return null;

	const existing = await manager.prisma.group.findUnique({
		where: { ownerId: userId },
		...PersonalWorkspaceArgs,
	});

	if (existing) {
		await manager.prisma.groupPermission.upsert({
			where: { groupId_userId: { groupId: existing.groupId, userId } },
			update: { role: 'GroupAdmin' },
			create: { groupId: existing.groupId, userId, role: 'GroupAdmin', grantedBy: userId },
		});
		return existing;
	}

	try {
		await manager.prisma.$transaction(async (tx) => {
			const alreadyCreated = await tx.group.findUnique({
				where: { ownerId: userId },
				select: { groupId: true },
			});
			if (alreadyCreated) return;

			const groupId = securityUtils.randomString(12);
			const groupIndex = await tx.group.aggregate({ _max: { index: true } });

			await tx.group.create({
				data: {
					groupId,
					name: personalGroupName,
					index: (groupIndex._max.index ?? -1) + 1,
					kind: 'Personal',
					ownerId: userId,
					permissions: {
						create: { userId, role: 'GroupAdmin', grantedBy: userId },
					},
				},
			});
		});
	} catch (error) {
		// Another request may have initialized the workspace concurrently.
		if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error;
	}

	return await manager.prisma.group.findUnique({
		where: { ownerId: userId },
		...PersonalWorkspaceArgs,
	});
}

export default [
	makeRoute({
		path: '/personal/:userId',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const userId = c.req.param('userId');
			if (!config.personalBoardsEnabled && !c.var.isDev) return json(c, 404, { error: 'Personal boards are disabled.' });
			if (!canAccessWorkspace(c.var.isDev, c.var.DBUser.userId, userId)) return json(c, 403, { error: 'You do not have access to this personal workspace.' });

			const workspace = await ensurePersonalWorkspace(userId);

			if (!workspace) return json(c, 404, { error: 'Personal workspace not found.' });

			return json(c, 200, {
				data: mapWorkspace(workspace),
			});
		},
	}),
	makeRoute({
		path: '/personal/categories',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!config.personalBoardsEnabled && !c.var.isDev) return json(c, 403, { error: 'You do not have permission to create personal categories.' });

			const isValid = nameObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const workspace = await ensurePersonalWorkspace(c.var.DBUser.userId);
			if (!workspace) return json(c, 404, { error: 'Personal workspace not found.' });

			const category = await manager.prisma.$transaction(async (tx) => {
				const categoryIndex = await tx.category.aggregate({
					where: { groupId: workspace.groupId },
					_max: { index: true },
				});

				return tx.category.create({
					select: { categoryId: true, name: true },
					data: {
						categoryId: securityUtils.randomString(12),
						name: isValid.data.name,
						groupId: workspace.groupId,
						index: (categoryIndex._max.index ?? -1) + 1,
					},
				});
			});

			return json(c, 200, { data: category });
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

			const category = await manager.prisma.category.findFirst({
				where: {
					categoryId,
					group: { kind: 'Personal', ownerId: userId },
				},
				select: {
					categoryId: true,
					boards: {
						orderBy: { index: 'asc' },
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
			});

			if (!category) return json(c, 404, { error: 'Personal category not found.' });

			return json(c, 200, {
				data: category.boards.map((board) => ({
					...board,
					id: board.boardId,
					categoryId: category.categoryId,
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

			const category = await manager.prisma.category.findFirst({
				where: {
					categoryId,
					group: { kind: 'Personal', ownerId: userId },
				},
				select: {
					categoryId: true,
					groupId: true,
				},
			});

			if (!category) return json(c, 404, { error: 'Personal category not found.' });

			const boardId = securityUtils.randomString(12);
			const board = await manager.prisma.$transaction(async (tx) => {
				const index = await tx.board.aggregate({
					where: { categoryId: category.categoryId },
					_max: { index: true },
				});

				return tx.board.create({
					data: {
						boardId,
						name: isValid.data.name,
						type: isValid.data.type,
						categoryId: category.categoryId,
						index: (index._max.index ?? -1) + 1,
					},
				});
			});

			const uploaded = await manager.files.uploadBoardFile(board.boardId, compressionUtils.compressAndEncrypt(isValid.data.type === 'Excalidraw' ? [] : {}), 'application/octet-stream').catch(() => null);
			if (!uploaded) {
				await manager.prisma.board.delete({ where: { boardId: board.boardId } }).catch(() => null);
				return json(c, 500, { error: 'Failed to initialize personal board.' });
			}

			return json(c, 200, {
				data: {
					groupId: category.groupId,
					categoryId: category.categoryId,
					boardId: board.boardId,
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
					category: {
						categoryId,
						group: { kind: 'Personal', ownerId: userId },
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
