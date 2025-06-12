import { json, makeRoute } from '../classes/routes';
import { db } from '../modules/prisma';
import manager from '../index';

export default [
	makeRoute({
		path: '/stats',
		method: 'GET',
		enabled: true,
		auth: true,
		devOnly: true,

		handler: async (c) => {
			const totalUsers = await db(manager, 'user', 'count', {});
			const totalGroups = await db(manager, 'group', 'count', {});
			const totalCategories = await db(manager, 'category', 'count', {});
			const totalBoards = await db(manager, 'board', 'count', {});
			const totalFiles = await db(manager, 'file', 'count', {});

			const allActivities = await db(manager, 'boardActivity', 'findMany', {
				select: {
					totalTimeSeconds: true,
					sessionCount: true,
					boardId: true,
				},
			}) || [];

			const topBoardActivities = await db(manager, 'boardActivity', 'groupBy', {
				by: ['boardId'],
				_sum: {
					totalTimeSeconds: true,
					sessionCount: true,
				},
				orderBy: {
					_sum: {
						totalTimeSeconds: 'desc',
					},
				},
				take: 10,
			});

			return json(c, 200, {
				data: {
					users: totalUsers,
					groups: totalGroups,
					categories: totalCategories,
					boards: totalBoards,
					files: totalFiles,
					boardActivity: {
						totalTimeSeconds: Math.round(allActivities.reduce((acc, activity) => acc + (activity.totalTimeSeconds || 0), 0) / 60),
						totalSessions: allActivities.reduce((acc, activity) => acc + (activity.sessionCount || 0), 0),
					},
					topBoardActivities: topBoardActivities?.map((activity) => ({
						boardId: activity.boardId,
						totalMinutes: Math.round((activity._sum.totalTimeSeconds || 0) / 60),
						sessionCount: activity._sum.sessionCount || 0,
					})) || [],
				},
			});
		},
	}),
	makeRoute({
		path: '/stats/user',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const requestedUserId = c.req.query('userId') || c.var.DBUser.userId;
			if (!c.var.isDev && c.var.DBUser.userId !== requestedUserId) return json(c, 403, { error: 'Access denied.' });

			const TargetDBUser = await db(manager, 'user', 'findUnique', {
				where: { userId: requestedUserId },
				select: {
					userId: true,
					email: true,
					displayName: true,
					isBoardsAdmin: true,
					ownedBoards: { select: { boardId: true } },
				},
			});
			if (!TargetDBUser) return json(c, 404, { error: 'User not found.' });

			const boardPermissionsCount = await db(manager, 'boardPermission', 'count', { where: { userId: requestedUserId } });

			const userActivityStats = await db(manager, 'boardActivity', 'findMany', {
				where: { userId: requestedUserId },
				select: {
					totalTimeSeconds: true,
					sessionCount: true,
					board: {
						select: {
							boardId: true,
							name: true,
						},
					},
				},
			}) || [];

			const perBoardActivity = userActivityStats.map((activity) => ({
				boardId: activity.board.boardId,
				boardName: activity.board.name,
				totalMinutes: Math.round((activity.totalTimeSeconds || 0) / 60),
				sessionCount: activity.sessionCount || 0,
			})).filter((activity) => activity.totalMinutes > 0);

			return json(c, 200, {
				data: {
					user: {
						id: TargetDBUser.userId,
						email: TargetDBUser.email,
						displayName: TargetDBUser.displayName,
						isBoardsAdmin: TargetDBUser.isBoardsAdmin,
					},
					ownedBoardsCount: TargetDBUser.ownedBoards.length,
					boardPermissionsCount,
					perBoardActivity,
					boardActivity: {
						totalTimeSeconds: userActivityStats.reduce((acc, activity) => acc + (activity.totalTimeSeconds || 0), 0),
						totalSessions: userActivityStats.reduce((acc, activity) => acc + (activity.sessionCount || 0), 0),
					},
				},
			});
		},
	}),
];
