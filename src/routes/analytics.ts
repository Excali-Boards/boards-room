import { json, makeRoute } from '../services/routes.js';
import { canManage } from '../other/permissions.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';

export default [
	makeRoute({
		path: '/analytics/user',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const activities = await db(manager, 'userBoardActivity', 'findMany', {
				where: { userId: c.var.DBUser.userId },
				orderBy: { lastActivityAt: 'desc' },
				select: {
					totalSessions: true,
					totalActiveSeconds: true,
					lastActivityAt: true,
					board: {
						select: {
							boardId: true,
							name: true,
							category: {
								select: {
									categoryId: true,
									name: true,
									group: {
										select: {
											groupId: true,
											name: true,
										},
									},
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, { data: activities });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/analytics',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const canViewAnalytics = canManage(c.var.DBUser, { type: 'board', data: { boardId, categoryId, groupId } });
			if (!canViewAnalytics) return json(c, 403, { error: 'You do not have permission to view analytics for this board.' });

			const activities = await db(manager, 'userBoardActivity', 'findMany', {
				where: { boardId },
				orderBy: { lastActivityAt: 'desc' },
				select: {
					totalSessions: true,
					totalActiveSeconds: true,
					lastActivityAt: true,
					user: {
						select: {
							userId: true,
							displayName: true,
							avatarUrl: true,
						},
					},
					board: {
						select: {
							boardId: true,
							name: true,
							category: {
								select: {
									categoryId: true,
									name: true,
									group: {
										select: {
											groupId: true,
											name: true,
										},
									},
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, { data: activities });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/analytics',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const categoryId = c.req.param('categoryId');
			const groupId = c.req.param('groupId');

			const canViewAnalytics = canManage(c.var.DBUser, { type: 'category', data: { categoryId, groupId } });
			if (!canViewAnalytics) return json(c, 403, { error: 'You do not have permission to view analytics for this category.' });

			const activities = await db(manager, 'userBoardActivity', 'findMany', {
				where: { board: { categoryId } },
				orderBy: { lastActivityAt: 'desc' },
				select: {
					totalSessions: true,
					totalActiveSeconds: true,
					lastActivityAt: true,
					user: {
						select: {
							userId: true,
							displayName: true,
							avatarUrl: true,
						},
					},
					board: {
						select: {
							boardId: true,
							name: true,
							category: {
								select: {
									categoryId: true,
									name: true,
									group: {
										select: {
											groupId: true,
											name: true,
										},
									},
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, { data: activities });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/analytics',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const canViewAnalytics = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canViewAnalytics) return json(c, 403, { error: 'You do not have permission to view analytics for this group.' });

			const activities = await db(manager, 'userBoardActivity', 'findMany', {
				where: { board: { category: { groupId } } },
				orderBy: { lastActivityAt: 'desc' },
				select: {
					totalSessions: true,
					totalActiveSeconds: true,
					lastActivityAt: true,
					user: {
						select: {
							userId: true,
							displayName: true,
							avatarUrl: true,
						},
					},
					board: {
						select: {
							boardId: true,
							name: true,
							category: {
								select: {
									categoryId: true,
									name: true,
									group: {
										select: {
											groupId: true,
											name: true,
										},
									},
								},
							},
						},
					},
				},
			}) || [];

			return json(c, 200, { data: activities });
		},
	}),
];

