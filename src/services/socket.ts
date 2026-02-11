import { ActionType, BareBoard, ClientToServerEvents, FileActionData, RoomData, ServerToClientEvents, SnapshotData } from '../types.js';
import { getSceneVersion, isInitializedImageElement, newElementWith, reconcileElements } from '../other/excalidraw.js';
import { compressionUtils, resolveClientIp } from '../modules/functions.js';
import { DBUserPartial, DBUserPartialType } from '../other/vars.js';
import { hasAccessToBoardWithIds } from '../other/permissions.js';
import { performanceConstants } from '../core/constants.js';
import { RoomSnapshot, TLSocketRoom } from '@tldraw/sync';
import { SocketId } from '@excalidraw/excalidraw/types';
import { serve, ServerType } from '@hono/node-server';
import LoggerModule from '../modules/logger.js';
import msgPack from 'socket.io-msgpack-parser';
import { BoardsManager } from '../index.js';
import { Server, Socket } from 'socket.io';
import { BoardType } from '@prisma/client';
import CustomMap from '../modules/map.js';
import config from '../core/config.js';
import { Readable } from 'node:stream';
import { db } from '../core/prisma.js';

export default class SocketServer {
	private honoServer: ServerType;
	public io: Server<ClientToServerEvents, ServerToClientEvents>;
	public connectionTimes = new Map<string, NodeJS.Timeout>();

	public excalidrawSocket = new ExcalidrawSocket(this);
	public tldrawSocket = new TldrawSocket(this);

	constructor (readonly manager: BoardsManager) {
		this.honoServer = serve({
			fetch: this.manager.hono.fetch,
			port: config.port,
		}, (info) => {
			LoggerModule('Hono', `🚀 Server started on port ${info.port}!\n`, 'green');
		});

		this.io = new Server(this.honoServer, {
			maxHttpBufferSize: performanceConstants.socketMaxBufferSize,
			parser: msgPack,
			cors: {
				credentials: true,
				methods: ['GET', 'POST'],
				origin: config.allowedOrigins,
				allowedHeaders: ['Content-Type', 'Authorization'],
			},
		});
	}

	public async init(): Promise<void> {
		this.initSavingBoards();
		this.handleConnection();
	}

	private async initSavingBoards(): Promise<void> {
		setInterval(() => {
			void this.saveAllBoards().catch((error) => {
				this.manager.prometheus.recordError('board_save_cycle_error', 'socket');
				LoggerModule('Socket', `Periodic board save failed: ${error}`, 'red');
			});
		}, performanceConstants.socketSaveIntervalMs);
	}

	public async saveAllBoards(): Promise<void> {
		await this.excalidrawSocket.saveAllBoards();
		await this.tldrawSocket.saveAllBoards();
	}

	private handleConnection(): void {
		this.io.on('connection', async (socket) => {
			try {
				if (config.rateLimiting.enabled) {
					const allowed = await this.enforceSocketRateLimit(socket);
					if (!allowed) return socket.disconnect(true);
				}

				const totalRooms = this.excalidrawSocket.roomData.size + this.tldrawSocket.roomData.size;
				this.manager.prometheus.updateSocketMetrics(this.io.sockets.sockets.size, totalRooms);

				const token = socket.handshake.auth.token as string;
				const targetRoom = socket.handshake.auth.room as string;
				if (!token || !targetRoom) return socket.disconnect(true);

				const DBUser = await db(this.manager, 'user', 'findFirst', { where: { sessions: { some: { token } } }, ...DBUserPartial });
				if (!DBUser) return socket.disconnect(true);

				const DBBoard = await db(this.manager, 'board', 'findUnique', { where: { boardId: targetRoom }, select: { files: true, boardId: true, version: true, type: true, category: { select: { groupId: true } }, categoryId: true } });
				if (!DBBoard) return socket.disconnect(true);

				const access = hasAccessToBoardWithIds(DBUser, DBBoard.boardId, DBBoard.categoryId, DBBoard.category.groupId);
				if (!access.hasAccess) return socket.disconnect(true);

				this.manager.prometheus.startUserSession(DBUser.userId, DBBoard.boardId, socket.id);

				const disconnectTimeout = setTimeout(() => {
					socket.disconnect(true);
					this.connectionTimes.delete(socket.id);
				}, 4 * 60 * 60 * 1000);

				this.connectionTimes.set(socket.id, disconnectTimeout);

				switch (DBBoard.type) {
					case 'Excalidraw': {
						return this.excalidrawSocket.setupSocket(socket, {
							boardId: DBBoard.boardId,
							files: DBBoard.files.map((f) => f.fileId),
							version: DBBoard.version || 0,
							canEdit: access.canEdit,
							boardType: 'Excalidraw',
						}, DBUser);
					}
					case 'Tldraw': {
						return this.tldrawSocket.setupSocket(socket, {
							boardId: DBBoard.boardId,
							files: DBBoard.files.map((f) => f.fileId),
							version: DBBoard.version || 0,
							canEdit: access.canEdit,
							boardType: 'Tldraw',
						}, DBUser);
					}
					default: {
						LoggerModule('Socket', `Connection rejected: Unsupported board type: ${DBBoard.type}. Socket: ${socket.id}`, 'red');
						socket.disconnect(true);
						return;
					}
				}
			} catch (error) {
				this.manager.prometheus.recordError('socket_connection_error', 'socket');
				LoggerModule('Socket', `Connection setup failed for socket ${socket.id}: ${error}`, 'red');
				socket.disconnect(true);
			}
		});
	}

	private async enforceSocketRateLimit(socket: Socket<ClientToServerEvents, ServerToClientEvents>): Promise<boolean> {
		const ip = resolveClientIp((name) => {
			const headerValue = socket.handshake.headers[name.toLowerCase()];
			return Array.isArray(headerValue) ? headerValue[0] : headerValue;
		}, socket.handshake.address || socket.conn.remoteAddress);

		if (!ip) return false;
		if (!this.manager.cache.isAvailable()) {
			LoggerModule('Security', 'Socket rate limiting requires Redis/Cache to be enabled and available.', 'red');
			return true;
		}

		const { windowMs, maxRequests } = config.rateLimiting.options;

		const now = Date.now();
		const cacheKey = `ratelimit:socket:${ip}`;
		const ttlSeconds = Math.ceil(windowMs / 1000);

		try {
			const cached = await this.manager.cache.get<{ count: number; lastRequest: number; }>(cacheKey);
			let record = cached || { count: 0, lastRequest: now };

			if (now - record.lastRequest > windowMs) {
				record = { count: 1, lastRequest: now };
			} else {
				record.count++;
			}

			await this.manager.cache.set(cacheKey, record, ttlSeconds);

			if (record.count > maxRequests) {
				LoggerModule('Security', `Socket rate limit exceeded for IP: ${ip} (${record.count}/${maxRequests} requests in ${windowMs}ms window)`, 'yellow');
				return false;
			}
		} catch (error) {
			LoggerModule('Security', `Socket rate limit Redis error for IP ${ip}: ${error instanceof Error ? error.message : 'Unknown'}`, 'red');
			this.manager.prometheus.recordError('socket_rate_limit_redis_error', 'socket');
		}

		return true;
	}

	public async handleFileAction<T extends ActionType>(boardId: string, boardType: BoardType, data: FileActionData<T>): Promise<{ success: number; failed: number; } | string | void> {
		const socket = this.getBoardSocket(boardType);
		if (!socket) return 'Board type does not support sockets.';

		switch (data.action) {
			case 'add': {
				const newFiles = data.files as FileActionData<'add'>['files'];

				const updated = socket.roomData.get(boardId);
				if (!updated) return 'Room data not found.';

				socket.queuedFiles.update(boardId, (files) => (files ?? []).filter((id) => !newFiles.some((f) => f.id === id)));

				const missing = newFiles.filter((f) => !updated.files.includes(f.id));
				if (!missing.length) return { success: newFiles.length, failed: 0 };

				updated.files.push(...missing.map((f) => f.id));

				const files = await socket.socket.manager.files.createFiles(missing, boardId);
				socket.socket.io.to(boardId).emit('filesUpdated', { ...files, total: missing.length });

				if (boardType === 'Excalidraw') {
					(updated as RoomData<'Excalidraw'>).elements = (updated as RoomData<'Excalidraw'>).elements.map((el) => {
						if (isInitializedImageElement(el)) {
							const f = missing.find((x) => x.id === el.fileId);
							return f ? newElementWith(el, { status: 'saved' }) : el;
						}

						return el;
					});
				}

				socket.roomData.set(boardId, updated as never);
				return files;
			}
			case 'remove': {
				const deleted = data.files as FileActionData<'remove'>['files'];
				const existing = socket.queuedFiles.get(boardId) || [];

				socket.queuedFiles.update(boardId, (files) => [
					...(files ?? []),
					...deleted.filter((file) => !existing.includes(file)),
				]);
			}
		}
	}

	public getBoardSocket<T extends BoardType>(boardType: T): T extends 'Excalidraw' ? ExcalidrawSocket : T extends 'Tldraw' ? TldrawSocket : null {
		type Internal = T extends 'Excalidraw' ? ExcalidrawSocket : T extends 'Tldraw' ? TldrawSocket : null;

		switch (boardType) {
			case 'Excalidraw': return this.excalidrawSocket as Internal;
			case 'Tldraw': return this.tldrawSocket as Internal;
			default: return null as Internal;
		}
	}
}

export class ExcalidrawSocket {
	public queuedFiles = new CustomMap<string, string[]>();
	public roomData = new CustomMap<string, RoomData<'Excalidraw'>>();

	constructor (readonly socket: SocketServer) { }

	public async saveAllBoards(): Promise<void> {
		const savePromises = Array.from(this.roomData.keys()).map((boardId) => this.saveSpecificBoard(boardId));
		await Promise.allSettled(savePromises);
	}

	private async saveSpecificBoard(boardId: string): Promise<void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const currentVersion = getSceneVersion(roomData.elements);
		const existingFile = await this.socket.manager.files.getBoardFile(boardId);

		if (existingFile) {
			try {
				const body = await this.socket.manager.files.readableToBuffer(existingFile.Body as Readable);
				const decompressed = compressionUtils.decompressAndDecrypt<RoomData<'Excalidraw'>['elements']>(body);
				const existingVersion = getSceneVersion(decompressed);

				if (currentVersion === existingVersion) return;
			} catch (error) {
				this.socket.manager.prometheus.recordError('version_compare_error', 'socket');
				LoggerModule('Socket', `Error comparing versions: ${error}`, 'red');
			}
		}

		const compressed = compressionUtils.compressAndEncrypt(roomData.elements.map((el) => ({
			...el, locked: true,
		})));

		const uploaded = await this.socket.manager.files.uploadBoardFile(boardId, compressed, 'application/octet-stream');
		if (!uploaded) throw new Error(`Failed to upload board data for ${boardId}.`);

		await db(this.socket.manager, 'board', 'update', {
			where: { boardId },
			data: {
				version: currentVersion,
				updatedAt: new Date(),
			},
		});
	}

	private async loadBoardElements(boardId: string): Promise<RoomData<'Excalidraw'>['elements']> {
		const s3File = await this.socket.manager.files.getBoardFile(boardId);
		if (!s3File) return [];

		try {
			const body = await this.socket.manager.files.readableToBuffer(s3File.Body as Readable);
			return compressionUtils.decompressAndDecrypt<RoomData<'Excalidraw'>['elements']>(body);
		} catch (error) {
			this.socket.manager.prometheus.recordError('board_load_error', 'socket');
			this.roomData.delete(boardId);
			this.socket.io.in(boardId).disconnectSockets();

			LoggerModule('Socket', `Critical error loading board ${boardId} from S3: ${error}`, 'red');
			throw new Error(`Failed to load board data for ${boardId}. All connections to this board have been terminated.`);
		}
	}

	public async getRoomData(room: string): Promise<RoomData<'Excalidraw'> | null> {
		const cached = this.roomData.get(room);
		if (cached) return cached;

		const DBBoard = await db(this.socket.manager, 'board', 'findUnique', { where: { boardId: room }, select: { files: true, boardId: true } });
		if (!DBBoard) return null;

		try {
			const elements = await this.loadBoardElements(room);
			return {
				elements,
				boardType: 'Excalidraw',
				boardId: DBBoard.boardId,
				files: DBBoard.files.map((f) => f.fileId),
				collaborators: new CustomMap(),
			};
		} catch (error) {
			this.socket.manager.prometheus.recordError('room_creation_error', 'socket');
			LoggerModule('Socket', `Error creating room: ${error}`, 'red');
			return null;
		}
	}

	public async setupSocket(socket: Socket<ClientToServerEvents, ServerToClientEvents>, DBBoard: BareBoard, DBUser: DBUserPartialType): Promise<void> {
		socket.emit('preloadFiles', DBBoard.files);

		const roomData = await this.roomData.getOrSet(DBBoard.boardId, async () => {
			const elements = await this.loadBoardElements(DBBoard.boardId);
			return {
				elements,
				boardId: DBBoard.boardId,
				files: DBBoard.files,
				boardType: 'Excalidraw',
				collaborators: new CustomMap(),
			};
		});

		roomData.collaborators.set(socket.id as SocketId, {
			id: DBUser.userId,
			username: DBUser.displayName,
			avatarUrl: DBUser.avatarUrl || undefined,
			socketId: socket.id as SocketId,
		});

		socket.join(DBBoard.boardId);
		this.roomData.set(DBBoard.boardId, roomData);

		socket.emit('init', { elements: roomData.elements });

		socket.broadcast.to(DBBoard.boardId).emit('setCollaborators', Array.from(roomData.collaborators.values()));
		setTimeout(() => socket.emit('setCollaborators', Array.from(roomData.collaborators.values())), performanceConstants.socketConnectionTimeoutMs);

		socket.on('presenceUpdate', (data) => {
			if (!data || (data.state !== 'active' && data.state !== 'idle' && data.state !== 'away')) return;
			this.socket.manager.prometheus.updateUserPresence(socket.id, data.state);
		});

		socket.on('disconnect', async () => {
			clearTimeout(this.socket.connectionTimes.get(socket.id));

			await this.socket.manager.prometheus.endUserSession(socket.id).catch((error) => {
				this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
				LoggerModule('Socket', `Failed to end user session for board ${DBBoard.boardId}: ${error}`, 'red');
			});

			const totalRooms = this.roomData.size + this.socket.tldrawSocket.roomData.size;
			this.socket.manager.prometheus.updateSocketMetrics(this.socket.io.sockets.sockets.size - 1, totalRooms);

			this.socket.connectionTimes.delete(socket.id);
			socket.leave(DBBoard.boardId);
			socket.removeAllListeners();

			const updatedRoom = this.roomData.get(DBBoard.boardId);
			if (!updatedRoom) return;

			updatedRoom.collaborators.delete(socket.id as SocketId);

			if (updatedRoom.collaborators.size) {
				this.roomData.set(DBBoard.boardId, updatedRoom);
				this.socket.io.to(DBBoard.boardId).emit('setCollaborators', Array.from(updatedRoom.collaborators.values()));
				return;
			}

			await this.saveSpecificBoard(DBBoard.boardId).catch((error) => {
				this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
				LoggerModule('Socket', `Failed to save board ${DBBoard.boardId} during disconnect cleanup: ${error}`, 'red');
			});

			const queued = this.queuedFiles.get(DBBoard.boardId);
			if (queued) {
				if (queued.length) {
					await this.socket.manager.files.deleteMediaFiles(DBBoard.boardId, queued).catch((error) => {
						this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
						LoggerModule('Socket', `Failed to delete queued media files for board ${DBBoard.boardId}: ${error}`, 'red');
					});
				}

				await this.socket.manager.files.deleteUnusedFiles(DBBoard.boardId).catch((error) => {
					this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
					LoggerModule('Socket', `Failed to delete unused files for board ${DBBoard.boardId}: ${error}`, 'red');
				});

				this.queuedFiles.delete(DBBoard.boardId);
			}

			this.roomData.delete(DBBoard.boardId);
			this.socket.io.in(DBBoard.boardId).disconnectSockets();
		});

		socket.on('broadcastScene', (data) => {
			if (!DBBoard.canEdit) return;
			this.socket.manager.prometheus.recordUserAction(socket.id);
			socket.broadcast.to(DBBoard.boardId).emit('broadcastScene', data);
		});

		socket.on('collaboratorPointerUpdate', (data) => {
			this.socket.manager.prometheus.recordUserAction(socket.id);
			socket.broadcast.to(DBBoard.boardId).emit('collaboratorPointerUpdate', data);
		});

		socket.on('relayVisibleSceneBounds', (data) => {
			this.socket.manager.prometheus.recordUserAction(socket.id);
			socket.broadcast.to(data.roomId).emit('relayVisibleSceneBounds', {
				bounds: data.bounds,
				socketId: socket.id,
			});
		});

		socket.on('userFollow', async (data) => {
			this.socket.manager.prometheus.recordUserAction(socket.id);
			const followRoom = `follows@${data.userToFollow.socketId}`;

			if (data.action === 'follow') await socket.join(followRoom);
			else await socket.leave(followRoom);

			const sockets = await this.socket.io.in(followRoom).fetchSockets() || [];
			const followedBy = sockets.map((s) => s.id);

			this.socket.io.to(data.userToFollow.socketId).emit('followedBy', followedBy);
		});

		socket.on('sendSnapshot', (data) => {
			if (!DBBoard.canEdit) return;
			this.socket.manager.prometheus.recordUserAction(socket.id);
			this.saveRoom(DBBoard.boardId, data);
		});
	}

	public async kickUser(boardId: string, userId: string): Promise<string | void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const collaboratorEntry = Array.from(roomData.collaborators.values()).filter((collaborator) => collaborator.id === userId || collaborator.socketId === userId);
		if (!collaboratorEntry.length) return;

		const socketId = collaboratorEntry.find((collaborator) => collaborator.socketId)?.socketId as SocketId;
		if (!socketId) return;

		this.socket.io.to(socketId).emit('kick');

		setTimeout(() => {
			const socket = this.socket.io.sockets.sockets.get(socketId);
			if (socket) socket.disconnect(true);
		}, 100);

		return collaboratorEntry.find((collaborator) => collaborator.socketId)?.username || 'Unknown User';
	}

	private async saveRoom(boardId: string, data: SnapshotData): Promise<void> {
		const current = await this.getRoomData(boardId);
		if (!current) return;

		const reconciled = reconcileElements(current.elements, data.elements);
		const version = getSceneVersion(reconciled);

		if (version !== getSceneVersion(current.elements)) {
			const cleaned = data.elements.filter((e) => !e.isDeleted);
			this.roomData.set(boardId, { ...current, elements: cleaned });
			this.socket.io.to(boardId).emit('sendSnapshot', data);
		}

		this.socket.io.to(boardId).emit('isSaved');
	}
}

export class TldrawSocket {
	public queuedFiles = new CustomMap<string, string[]>();
	public roomData = new CustomMap<string, RoomData<'Tldraw'>>();

	constructor (readonly socket: SocketServer) { }

	public async saveAllBoards(): Promise<void> {
		const boardIds = Array.from(this.roomData.keys());
		const savePromises = boardIds.map((boardId) => this.saveSpecificBoard(boardId));
		await Promise.allSettled(savePromises);
	}

	private async saveSpecificBoard(boardId: string): Promise<void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const currentSnapshot = roomData.room.getCurrentSnapshot();
		const existingFile = await this.socket.manager.files.getBoardFile(boardId);

		if (existingFile) {
			try {
				const body = await this.socket.manager.files.readableToBuffer(existingFile.Body as Readable);
				const decompressed = compressionUtils.decompressAndDecrypt<RoomSnapshot>(body);
				if (currentSnapshot.clock === decompressed.clock) return;

			} catch (error) {
				this.socket.manager.prometheus.recordError('version_compare_error', 'socket');
				LoggerModule('Socket', `Error comparing versions: ${error}`, 'red');
			}
		}

		const compressed = compressionUtils.compressAndEncrypt(currentSnapshot);

		const uploaded = await this.socket.manager.files.uploadBoardFile(boardId, compressed, 'application/octet-stream');
		if (!uploaded) throw new Error(`Failed to upload board data for ${boardId}.`);

		await db(this.socket.manager, 'board', 'update', {
			where: { boardId },
			data: {
				version: currentSnapshot.clock,
				updatedAt: new Date(),
			},
		});
	}

	private async loadBoardSnapshot(boardId: string): Promise<RoomSnapshot | null> {
		const s3File = await this.socket.manager.files.getBoardFile(boardId);
		if (!s3File) return null;

		try {
			const body = await this.socket.manager.files.readableToBuffer(s3File.Body as Readable);
			const decompressed = compressionUtils.decompressAndDecrypt<RoomSnapshot>(body);

			if (Object.keys(decompressed).length === 0) return null;
			return decompressed;
		} catch (error) {
			this.socket.manager.prometheus.recordError('board_load_error', 'socket');
			this.roomData.delete(boardId);
			this.socket.io.in(boardId).disconnectSockets();

			LoggerModule('Socket', `Critical error loading board ${boardId} from S3: ${error}`, 'red');
			throw new Error(`Failed to load board data for ${boardId}. All connections to this board have been terminated.`);
		}
	}

	public async getRoomData(room: string): Promise<RoomData<'Tldraw'> | null> {
		const cached = this.roomData.get(room);
		if (cached) return cached;

		const DBBoard = await db(this.socket.manager, 'board', 'findUnique', { where: { boardId: room }, select: { files: true, boardId: true } });
		if (!DBBoard) return null;

		try {
			const snapshot = await this.loadBoardSnapshot(room);

			return {
				boardType: 'Tldraw',
				boardId: DBBoard.boardId,
				files: DBBoard.files.map((f) => f.fileId),
				collaborators: new CustomMap(),
				needsPersist: false,

				room: new TLSocketRoom({
					initialSnapshot: snapshot || undefined,
					onSessionRemoved: () => {
						this.roomData.delete(room);
					},
					onDataChange: async () => {
						const current = await this.getRoomData(room);
						if (!current) return;

						this.roomData.set(room, { ...current, needsPersist: true });
					},
				}),
			};
		} catch (error) {
			this.socket.manager.prometheus.recordError('room_creation_error', 'socket');
			LoggerModule('Socket', `Error creating room: ${error}`, 'red');
			return null;
		}
	}

	public async setupSocket(socket: Socket<ClientToServerEvents, ServerToClientEvents>, DBBoard: BareBoard, DBUser: DBUserPartialType): Promise<void> {
		const roomData = await this.roomData.getOrSet(DBBoard.boardId, async () => {
			const snapshot = await this.loadBoardSnapshot(DBBoard.boardId);

			return {
				boardId: DBBoard.boardId,
				files: DBBoard.files,
				boardType: 'Tldraw',
				collaborators: new CustomMap(),
				needsPersist: false,

				room: new TLSocketRoom({
					initialSnapshot: snapshot || undefined,
					onSessionRemoved: (room, args) => {
						if (!args.numSessionsRemaining) room.close();
					},
					onDataChange: async () => {
						const current = await this.getRoomData(DBBoard.boardId);
						if (!current) return;

						this.roomData.set(DBBoard.boardId, { ...current, needsPersist: true });
					},
				}),
			};
		});

		roomData.collaborators.set(socket.id as SocketId, {
			id: DBUser.userId,
			username: DBUser.displayName,
			avatarUrl: DBUser.avatarUrl || undefined,
			socketId: socket.id as SocketId,
		});

		socket.join(DBBoard.boardId);
		this.roomData.set(DBBoard.boardId, roomData);

		socket.on('tldraw', (message) => {
			this.socket.manager.prometheus.recordUserAction(socket.id);
			roomData.room.handleSocketMessage(socket.id as SocketId, message);
		});

		roomData.room.handleSocketConnect({
			isReadonly: !DBBoard.canEdit,
			sessionId: socket.id as SocketId,
			socket: {
				send: (message) => socket.emit('tldraw', message),
				close: () => socket.disconnect(true),
				get readyState() {
					return socket.connected ? 1 : 3; // 1 = OPEN, 3 = CLOSED
				},
			},
		});

		socket.emit('init', { snapshot: null });

		socket.on('presenceUpdate', (data) => {
			if (!data || (data.state !== 'active' && data.state !== 'idle' && data.state !== 'away')) return;
			this.socket.manager.prometheus.updateUserPresence(socket.id, data.state);
		});

		socket.on('disconnect', async () => {
			clearTimeout(this.socket.connectionTimes.get(socket.id));

			await this.socket.manager.prometheus.endUserSession(socket.id).catch((error) => {
				this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
				LoggerModule('Socket', `Failed to end user session for board ${DBBoard.boardId}: ${error}`, 'red');
			});

			const totalRooms = this.roomData.size + this.socket.excalidrawSocket.roomData.size;
			this.socket.manager.prometheus.updateSocketMetrics(this.socket.io.sockets.sockets.size - 1, totalRooms);

			this.socket.connectionTimes.delete(socket.id);
			socket.leave(DBBoard.boardId);
			socket.removeAllListeners();

			const updatedRoom = this.roomData.get(DBBoard.boardId);
			if (!updatedRoom) return;

			updatedRoom.collaborators.delete(socket.id as SocketId);

			if (updatedRoom.collaborators.size) {
				this.roomData.set(DBBoard.boardId, updatedRoom);
				return;
			}

			await this.saveSpecificBoard(DBBoard.boardId).catch((error) => {
				this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
				LoggerModule('Socket', `Failed to save board ${DBBoard.boardId} during disconnect cleanup: ${error}`, 'red');
			});

			const queued = this.queuedFiles.get(DBBoard.boardId);
			if (queued) {
				if (queued.length) {
					await this.socket.manager.files.deleteMediaFiles(DBBoard.boardId, queued).catch((error) => {
						this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
						LoggerModule('Socket', `Failed to delete queued media files for board ${DBBoard.boardId}: ${error}`, 'red');
					});
				}

				await this.socket.manager.files.deleteUnusedFiles(DBBoard.boardId).catch((error) => {
					this.socket.manager.prometheus.recordError('socket_disconnect_cleanup_error', 'socket');
					LoggerModule('Socket', `Failed to delete unused files for board ${DBBoard.boardId}: ${error}`, 'red');
				});

				this.queuedFiles.delete(DBBoard.boardId);
			}

			this.roomData.delete(DBBoard.boardId);
			this.socket.io.in(DBBoard.boardId).disconnectSockets();
		});
	}

	public async kickUser(boardId: string, userId: string): Promise<string | void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const collaboratorEntry = Array.from(roomData.collaborators.values()).filter((collaborator) => collaborator.id === userId || collaborator.socketId === userId);
		if (!collaboratorEntry.length) return;

		const socketId = collaboratorEntry.find((collaborator) => collaborator.socketId)?.socketId as SocketId;
		if (!socketId) return;

		this.socket.io.to(socketId).emit('kick');

		setTimeout(() => {
			const socket = this.socket.io.sockets.sockets.get(socketId);
			if (socket) socket.disconnect(true);
		}, 100);

		return collaboratorEntry.find((collaborator) => collaborator.socketId)?.username || 'Unknown User';
	}
}
