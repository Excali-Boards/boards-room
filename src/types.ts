import { SocketId, Collaborator, BinaryFileData } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { ExcalidrawElement } from '@excalidraw/excalidraw/dist/types/excalidraw/element/types';
import { HttpBindings } from '@hono/node-server';
import { TSPrisma, User } from '@prisma/client';
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
export type TSUser = TSPrisma.TSPrismaModelsFull['User'];
export type Group = TSPrisma.TSPrismaModelsFull['Group'];
export type Category = TSPrisma.TSPrismaModelsFull['Category'];
export type Board = TSPrisma.TSPrismaModelsFull['Board'];
export type File = TSPrisma.TSPrismaModelsFull['File'];
export type BoardPermission = TSPrisma.TSPrismaModelsFull['BoardPermission'];

// Routes.
export type StatusWebCode = 200 | 400 | 401 | 403 | 404 | 429 | 500 | 503;
export type StatusWebResponse<T, S extends StatusWebCode> =
	S extends 200 ? {
		status: S;
		data: T;
	} : {
		status: S;
		error: unknown;
	};

export type HonoEnv<Auth extends boolean = boolean> = {
	Bindings: HttpBindings;
	Variables: {
		isDev: Auth extends true ? boolean : never;
		privileged: Auth extends true ? boolean : never;
		DBUser: Auth extends true ? (Omit<User, 'dbId'> & {
			boardPermissions: Pick<BoardPermission, 'boardId' | 'permissionType'>[];
			ownedBoards: Pick<Board, 'boardId' | 'name'>[];
		}) : never;
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

	filesUpdated: () => unknown;
	preloadFiles: (files: string[]) => unknown;

	followedBy: (data: string[]) => unknown;
	setCollaborators: (collaborators: Collaborator[]) => unknown;
	broadcastScene: (data: SceneBroadcastData) => unknown;
	collaboratorPointerUpdate: (data: CollaboratorPointer) => unknown;
	relayVisibleSceneBounds: (data: BoundsData<'socketId'>) => unknown;
	sendSnapshot: (data: SnapshotData) => unknown;
}

// For: socket.on
export type ClientToServerEvents = {
	sendSnapshot: (data: SnapshotData) => unknown;
	broadcastScene: (data: SceneBroadcastData) => unknown;
	collaboratorPointerUpdate: (data: CollaboratorPointer) => unknown;
	userFollow: (data: OnUserFollowedPayload) => unknown;
	relayVisibleSceneBounds: (data: BoundsData<'roomId'>) => unknown;
	fileAction: <T extends ActionType>(data: FileActionData<T>) => unknown;
}
