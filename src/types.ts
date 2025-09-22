import { SocketId, Collaborator, BinaryFileData } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { TSPrisma, BoardRole, CategoryRole, GroupRole, Invite as PrismaInvite } from '@prisma/client';
import { ExcalidrawElement } from '@excalidraw/excalidraw/dist/types/excalidraw/element/types';
import { HttpBindings } from '@hono/node-server';
import { DBUserPartialType } from './other/vars';
import { MiddlewareHandler } from 'hono';
import CustomMap from './modules/map';

export type WebResponse<T> = {
	status: 200;
	data: T;
} | {
	status: 400 | 401 | 403 | 404 | 500 | 503;
	error: unknown;
}

export type CancelOutWebResponses<T extends WebResponse<unknown>> = T extends { status: 200, data: infer U } ? U : never;
export type NonUndefined<T> = T extends undefined ? never : T;

export type Simplify<T> = {
	[P in keyof T]: T[P];
};

export type NoNestedReadonly<T> = {
	-readonly [P in keyof T]: T[P];
};

export type DeepRequired<T> = { [P in keyof T]-?: DeepRequired<T[P]>; };
export type DeepPartial<T, N extends boolean> = { [P in keyof T]?: DeepPartial<T[P], N> | (N extends true ? null : undefined); };
export type DeepRequiredRemoveNull<T> = { [P in keyof T]-?: Exclude<DeepRequiredRemoveNull<T[P]>, null>; };
export type DeepNonNullable<T> = { [P in keyof T]-?: DeepNonNullable<NonNullable<T[P]>>; };
export type DeepNonReadonly<T> = { -readonly [P in keyof T]: DeepNonReadonly<T[P]>; };

export type KeysOf<T> = T extends Record<string, unknown> ? {
	[K in keyof T]-?: K extends string ? `${K}` | (T[K] extends null | undefined ? never : `${K}.${KeysOf<NonNullable<T[K]>>}`) : never;
}[keyof T] : never;

// Structures.
export type User = TSPrisma.TSPrismaModelsFull['User'];
export type Group = TSPrisma.TSPrismaModelsFull['Group'];
export type Category = TSPrisma.TSPrismaModelsFull['Category'];
export type Board = TSPrisma.TSPrismaModelsFull['Board'];
export type File = TSPrisma.TSPrismaModelsFull['File'];
export type LoginMethod = TSPrisma.TSPrismaModelsFull['LoginMethod'];

// Permission models
export type GroupPermission = TSPrisma.TSPrismaModelsFull['GroupPermission'];
export type CategoryPermission = TSPrisma.TSPrismaModelsFull['CategoryPermission'];
export type BoardPermission = TSPrisma.TSPrismaModelsFull['BoardPermission'];
export type Invite = TSPrisma.TSPrismaModelsFull['Invite'];

// Permission roles.
export type UserRole = BoardRole | CategoryRole | GroupRole | GlobalRole.Developer;

export enum GlobalRole {
	Developer = 'Developer',
}

// Resource types.
export type AccessLevel = 'read' | 'write' | 'manage' | 'admin';
export type ResourceTypeGeneric<A extends GlobalResourceType> = { type: A; data: ResourceId<A>; };

export type ResourceId<A extends GlobalResourceType> =
	A extends 'board' ? { boardId: string; categoryId: string; groupId: string; } :
	A extends 'category' ? { categoryId: string; groupId: string; } :
	A extends 'group' ? { groupId: string; } :
	A extends 'global' ? null :
	never;

export type ResourceReturnEnum<A extends GlobalResourceType> =
	A extends 'board' ? BoardRole :
	A extends 'category' ? CategoryRole :
	A extends 'group' ? GroupRole :
	A extends 'global' ? GlobalRole :
	never;

export type ResourceType = 'group' | 'category' | 'board';
export type GlobalResourceType = ResourceType | 'global';

export type PermissionGrantResult = {
	newPermissions: GrantedRoles;
	updatedPermissions: (GrantedRole & { dbId: string })[];
};

export type GrantedRoles = GrantedRole[];
export type GrantedRole = {
	type: ResourceType;
	resourceId: string;
	role: UserRole;
};

export type BareBoard = {
	boardId: string;
	files: string[];
	version: number;
	canEdit: boolean;
};

export type InviteData = Pick<PrismaInvite, 'code' | 'expiresAt' | 'maxUses' | 'currentUses' | 'boardRole' | 'categoryRole' | 'groupRole'> & {
	groups: { groupId: string; name: string; }[];
	categories: { categoryId: string; name: string; groupId: string; }[];
	boards: { boardId: string; name: string; categoryId: string; }[];
};

// Other.
export type IpApiResponse = {
	status: 'fail';
	message: string;
} | {
	status: 'success';
	country: string;
	regionName: string;
	city: string;
};

export type GrantedEntry = {
	type: ResourceType;
	role: UserRole;
	resourceId: string;
	basedOnType: ResourceType;
	basedOnResourceId: string;
};

// Routes.
export type StatusWebCode = 200 | 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503;
export type StatusWebResponse<T, S extends StatusWebCode> =
	S extends 200 ? {
		status: S;
		data: T;
	} : {
		status: S;
		error: unknown;
		retryAfter?: number;
	};

export type HonoEnv<Auth extends boolean = boolean> = {
	Bindings: HttpBindings;
	Variables: {
		isDev: Auth extends true ? boolean : never;
		token: Auth extends true ? string : never;

		DBUser: Auth extends true ? DBUserPartialType : never;
	};
};

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
export type RouteType<
	Path extends `/${string}` = `/${string}`,
	Auth extends boolean = false,
> = {
	path: Path;
	method: RouteMethod;

	enabled: boolean;

	auth?: Auth;
	devOnly?: boolean;
	customAuth?: string;

	handler: MiddlewareHandler<Auth extends true ? HonoEnv<Auth> : Omit<HonoEnv, 'Variables'>, Path>;
};

// Socket.
export type RoomData = {
	boardId: string;

	files: string[];
	elements: ExcalidrawElement[];
	collaborators: CustomMap<SocketId, NoNestedReadonly<Collaborator>>;
};

export type ClientData = {
	elements: ExcalidrawElement[];
};

export type SceneBroadcastData = {
	elements: ExcalidrawElement[];
	commitToHistory?: boolean;
};

export type CollaboratorPointer = {
	socketId: string;
	username: string;
	state?: 'active' | 'idle' | 'away';
	selectedElementIds?: string[];
	button?: 'up' | 'down';
	pointer?: {
		tool: 'pointer' | 'laser';
		x: number;
		y: number;
	};
};

export type UserToFollow = {
	socketId: string;
	username: string;
};

export type OnUserFollowedPayload = {
	userToFollow: UserToFollow;
	action: 'follow' | 'unfollow';
};

export type SceneBounds = readonly [
	sceneX: number,
	sceneY: number,
	sceneX2: number,
	sceneY2: number,
];

export type BoundsData<T extends string> = {
	[x in T]: string;
} & {
	bounds: SceneBounds;
};

export type SnapshotData = {
	elements: ExcalidrawElement[];
};

export type StatsData = {
	success: number;
	failed: number;
	total: number;
};

export type ActionType = 'add' | 'remove';
export type FileActionData<T extends ActionType> = {
	action: T;
	files: T extends 'add' ? BinaryFileData[] : string[];
};

// For: socket.emit or io.to().emit, io.emit
export type ServerToClientEvents = {
	init: (data: ClientData) => unknown;
	isSaved: () => unknown;
	kick: () => unknown;

	filesUpdated: (stats?: StatsData) => unknown;
	preloadFiles: (files: string[]) => unknown;

	followedBy: (data: string[]) => unknown;
	setCollaborators: (collaborators: Collaborator[]) => unknown;
	broadcastScene: (data: SceneBroadcastData) => unknown;
	collaboratorPointerUpdate: (data: CollaboratorPointer) => unknown;
	relayVisibleSceneBounds: (data: BoundsData<'socketId'>) => unknown;
	sendSnapshot: (data: SnapshotData) => unknown;
};

// For: socket.on
export type ClientToServerEvents = {
	sendSnapshot: (data: SnapshotData) => unknown;
	broadcastScene: (data: SceneBroadcastData) => unknown;
	collaboratorPointerUpdate: (data: CollaboratorPointer) => unknown;
	userFollow: (data: OnUserFollowedPayload) => unknown;
	relayVisibleSceneBounds: (data: BoundsData<'roomId'>) => unknown;
	fileAction: <T extends ActionType>(data: FileActionData<T>) => unknown;
};

export type SystemStatus = {
	cpuUsage: number;
	memoryUsage: string;

	activeRooms: number;
	socketConnections: number;
	queuedFiles: number;

	totalUsers: number;
	totalInvites: number;

	totalBoards: number;
	totalCategories: number;
	totalGroups: number;
};
