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

export const PersonalWorkspaceArgs = {
	select: {
		groupId: true,
		user: {
			select: {
				userId: true,
				displayName: true,
				email: true,
				avatarUrl: true,
			},
		},
		boards: {
			select: {
				categoryId: true,
				board: {
					select: {
						boardId: true,
						categoryId: true,
						name: true,
						type: true,
						index: true,
						totalSizeBytes: true,
						scheduledForDeletion: true,
					},
				},
			},
		},
		categories: {
			orderBy: { index: 'asc' },
			select: {
				dbId: true,
				categoryId: true,
				name: true,
				backingCategoryId: true,
				boards: {
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
		},
	},
} satisfies Prisma.PersonalWorkspaceDefaultArgs;

export const DBUserPartial = Prisma.validator<Prisma.UserDefaultArgs>()(DBUserSelectArgs);
export type DBUserPartialType = Prisma.UserGetPayload<typeof DBUserPartial>;

export const DBUserAnalytics = Prisma.validator<Prisma.UserBoardActivityDefaultArgs>()(DBUserAnalyticsArgs);
export type DBUserAnalyticsType = Prisma.UserBoardActivityGetPayload<typeof DBUserAnalytics>;

export const PersonalWorkspace = Prisma.validator<Prisma.PersonalWorkspaceDefaultArgs>()(PersonalWorkspaceArgs);
export type PersonalWorkspaceType = Prisma.PersonalWorkspaceGetPayload<typeof PersonalWorkspace>;
