import { Prisma } from '@prisma/client';

export const DBUserSelectArgs = {
	select: {
		email: true,
		userId: true,
		avatarUrl: true,
		invitedBy: true,
		mainGroupId: true,
		displayName: true,
		mainLoginType: true,
		groupPermissions: { select: { groupId: true, role: true } },
		categoryPermissions: { select: { categoryId: true, role: true } },
		boardPermissions: { select: { boardId: true, role: true } },
		loginMethods: { select: { platform: true, platformEmail: true } },
	},
} satisfies Prisma.UserDefaultArgs;

export const DBUserAnalyticsArgs = {
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
};

export const DBUserPartial = Prisma.validator<Prisma.UserDefaultArgs>()(DBUserSelectArgs);
export type DBUserPartialType = Prisma.UserGetPayload<typeof DBUserPartial>;

export const DBUserAnalytics = Prisma.validator<Prisma.UserBoardActivityDefaultArgs>()(DBUserAnalyticsArgs);
export type DBUserAnalyticsType = Prisma.UserBoardActivityGetPayload<typeof DBUserAnalytics>;
