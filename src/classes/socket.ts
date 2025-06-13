import { getSceneVersion, isInitializedImageElement, newElementWith, reconcileElements } from '../modules/excali';
import { ClientToServerEvents, FileActionData, RoomData, ServerToClientEvents, SnapshotData } from '../types';
import { SocketId } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { securityUtils, compressionUtils } from '../modules/utils';
import { BoardPermission, User } from '@prisma/client';
import { serve, ServerType } from '@hono/node-server';
import msgPack from 'socket.io-msgpack-parser';
import LoggerModule from '../modules/logger';
import { Server, Socket } from 'socket.io';
import { BoardsManager } from '../index';
import CustomMap from '../modules/map';
import config from '../modules/config';
import { Readable } from 'node:stream';
import { db } from '../modules/prisma';

export default class SocketServer {
	public roomData = new CustomMap<string, RoomData>();
	public queuedFiles = new CustomMap<string, string[]>();
	private connectionTimes = new Map<string, NodeJS.Timeout>();

	private honoServer: ServerType | null = null;
	public io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

	constructor (readonly manager: BoardsManager) { }

	public async init(): Promise<void> {
		this.honoServer = serve({
			fetch: this.manager.hono.fetch,
			port: config.port,
		}, (info) => {
			LoggerModule('Hono', `🚀 Server started on port ${info.port}!\n`, 'green');
		});

		this.io = new Server(this.honoServer, {
			maxHttpBufferSize: 100 * 1024 * 1024,
			parser: msgPack,
			cors: {
				credentials: true,
				methods: ['GET', 'POST'],
				origin: config.allowedOrigins,
				allowedHeaders: ['Content-Type', 'Authorization'],
			},
		});

		this.initSavingBoards();
		this.handleConnection();
	}

	private async initSavingBoards(): Promise<void> {
		setInterval(async () => this.saveAllBoards(), 1000 * 15); // 15 seconds
	}

	public async saveAllBoards(): Promise<void> {
		const savePromises = Array.from(this.roomData.keys()).map((boardId) => this.saveSpecificBoard(boardId));
		await Promise.allSettled(savePromises);
	}

	private async saveSpecificBoard(boardId: string): Promise<void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const currentVersion = getSceneVersion(roomData.elements);
		const existingFile = await this.manager.files.getFile(`boards/${boardId}.bin`);

		if (existingFile) {
			try {
				const body = await this.manager.files.readableToBuffer(existingFile.Body as Readable);
				const decompressed = compressionUtils.decompressAndDecrypt<RoomData['elements']>(body);
				const existingVersion = getSceneVersion(decompressed);

				if (currentVersion === existingVersion) return;
			} catch (error) {
				console.error('Error comparing versions:', error);
			}
		}

		const compressed = compressionUtils.compressAndEncrypt(roomData.elements);

		const uploaded = await this.manager.files.uploadFile(`boards/${boardId}.bin`, compressed, 'application/octet-stream');
		if (!uploaded) throw new Error(`Failed to upload board data for ${boardId}`);

		await db(this.manager, 'board', 'update', {
			where: { boardId },
			data: {
				version: currentVersion,
				updatedAt: new Date(),
			},
		});
	}

	private async loadBoardElements(boardId: string): Promise<RoomData['elements']> {
		const s3File = await this.manager.files.getFile(`boards/${boardId}.bin`);
		if (!s3File) return [];

		try {
			const body = await this.manager.files.readableToBuffer(s3File.Body as Readable);
			return compressionUtils.decompressAndDecrypt<RoomData['elements']>(body);
		} catch (error) {
			this.roomData.delete(boardId);
			this.io?.in(boardId).disconnectSockets();

			console.error(`Critical error loading board ${boardId} from S3:`, error);
			throw new Error(`Failed to load board data for ${boardId}. All connections to this board have been terminated.`);
		}
	}

	public async getRoomData(room: string): Promise<RoomData | null> {
		const cached = this.roomData.get(room);
		if (cached) return cached;

		const DBBoard = await db(this.manager, 'board', 'findUnique', { where: { boardId: room }, include: { files: true } });
		if (!DBBoard) return null;

		try {
			const elements = await this.loadBoardElements(room);
			return {
				elements,
				boardId: DBBoard.boardId,
				files: DBBoard.files.map((f) => f.fileId),
				collaborators: new CustomMap(),
			};
		} catch (error) {
			console.error(error);
			return null;
		}
	}

	private handleConnection(): void {
		this.io?.on('connection', async (socket) => {
			const token = socket.handshake.auth.token as string;
			const targetRoom = socket.handshake.auth.room as string;
			if (!token || !targetRoom) return socket.disconnect(true);

			const DBUser = await db(this.manager, 'user', 'findFirst', { where: { email: token }, include: { boardPermissions: true } });
			if (!DBUser) return socket.disconnect(true);

			const DBBoard = await db(this.manager, 'board', 'findUnique', { where: { boardId: targetRoom }, include: { files: true } });
			if (!DBBoard) return socket.disconnect(true);

			const DBPermission = DBUser.boardPermissions.find((p) => p.boardId === DBBoard.boardId);
			const isPrivileged = config.developers.includes(securityUtils.decrypt(DBUser.email)) || DBUser.isBoardsAdmin;

			const canEdit = isPrivileged || DBPermission?.permissionType === 'Write';
			const allowed = isPrivileged || !!DBPermission;
			if (!allowed) return socket.disconnect(true);

			await db(this.manager, 'boardActivity', 'upsert', {
				where: {
					userId_boardId: {
						userId: DBUser.userId,
						boardId: DBBoard.boardId,
					},
				},
				update: {
					sessionCount: { increment: 1 },
					lastOpened: new Date(),
				},
				create: {
					userId: DBUser.userId,
					boardId: DBBoard.boardId,
					lastOpened: new Date(),
					sessionCount: 1,
				},
			});

			const disconnectTimeout = setTimeout(() => {
				socket.disconnect(true);
				this.connectionTimes.delete(socket.id);
			}, 4 * 60 * 60 * 1000);

			this.connectionTimes.set(socket.id, disconnectTimeout);
			return await this.setupSocket(
				socket,
				{
					boardId: DBBoard.boardId,
					files: DBBoard.files.map((f) => f.fileId),
					version: DBBoard.version || 0,
					canEdit,
				},
				{
					userId: DBUser.userId,
					displayName: DBUser.displayName,
					avatarUrl: DBUser.avatarUrl,
					isBoardsAdmin: DBUser.isBoardsAdmin,
					boardPermissions: DBUser.boardPermissions,
				},
			);
		});
	}

	private async setupSocket(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		DBBoard: { boardId: string; files: string[]; version: number; canEdit: boolean; },
		DBUser: Omit<User, 'dbId' | 'email' | 'mainGroupId' | 'mainLoginType'> & { boardPermissions: BoardPermission[]; },
	): Promise<void> {
		socket.emit('preloadFiles', DBBoard.files);

		const roomData = await this.roomData.getOrSet(DBBoard.boardId, async () => {
			const elements = await this.loadBoardElements(DBBoard.boardId);
			return {
				elements,
				boardId: DBBoard.boardId,
				files: DBBoard.files,
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
		setTimeout(() => socket.emit('setCollaborators', Array.from(roomData.collaborators.values())), 1000);

		socket.on('disconnect', async () => {
			clearTimeout(this.connectionTimes.get(socket.id));
			this.connectionTimes.delete(socket.id);

			socket.leave(DBBoard.boardId);
			socket.removeAllListeners();

			const updatedRoom = await this.getRoomData(DBBoard.boardId);
			if (!updatedRoom) return;

			updatedRoom.collaborators.delete(socket.id as SocketId);

			if (updatedRoom.collaborators.size) this.roomData.set(DBBoard.boardId, updatedRoom);
			else {
				await this.saveSpecificBoard(DBBoard.boardId);

				const queued = this.queuedFiles.get(DBBoard.boardId);
				if (queued) {
					if (queued.length) await this.manager.files.deleteFiles(queued, DBBoard.boardId);
					this.manager.files.deleteUnusedFiles(DBBoard.boardId);
					this.queuedFiles.delete(DBBoard.boardId);
				}

				this.roomData.delete(DBBoard.boardId);
				this.io?.in(DBBoard.boardId).disconnectSockets();
			}

			this.io?.to(DBBoard.boardId).emit('setCollaborators', Array.from(updatedRoom.collaborators.values()));

			const DBActivity = await db(this.manager, 'boardActivity', 'findUnique', { where: { userId_boardId: { userId: DBUser.userId, boardId: DBBoard.boardId } } });

			if (DBActivity?.lastOpened) {
				await db(this.manager, 'boardActivity', 'update', {
					where: { userId_boardId: { userId: DBUser.userId, boardId: DBBoard.boardId } },
					data: { totalTimeSeconds: { increment: Math.round((Date.now() - DBActivity.lastOpened.getTime()) / 1000) } },
				});
			} else {
				await db(this.manager, 'boardActivity', 'upsert', {
					where: { userId_boardId: { userId: DBUser.userId, boardId: DBBoard.boardId } },
					update: {},
					create: {
						userId: DBUser.userId,
						boardId: DBBoard.boardId,
						totalTimeSeconds: Math.round((Date.now() - new Date(socket.handshake.time).getTime()) / 1000),
					},
				});
			}
		});

		socket.on('broadcastScene', (data) => {
			if (!DBBoard.canEdit) return;
			socket.broadcast.to(DBBoard.boardId).emit('broadcastScene', data);
		});

		socket.on('collaboratorPointerUpdate', (data) => {
			socket.broadcast.to(DBBoard.boardId).emit('collaboratorPointerUpdate', data);
		});

		socket.on('relayVisibleSceneBounds', (data) => {
			socket.broadcast.to(data.roomId).emit('relayVisibleSceneBounds', {
				bounds: data.bounds,
				socketId: socket.id,
			});
		});

		socket.on('userFollow', async (data) => {
			const followRoom = `follows@${data.userToFollow.socketId}`;

			if (data.action === 'follow') await socket.join(followRoom);
			else await socket.leave(followRoom);

			const sockets = await this.io?.in(followRoom).fetchSockets() || [];
			const followedBy = sockets.map((s) => s.id);

			this.io?.to(data.userToFollow.socketId).emit('followedBy', followedBy);
		});

		socket.on('sendSnapshot', (data) => {
			if (!DBBoard.canEdit) return;
			this.saveRoom(DBBoard.boardId, data);
		});

		socket.on('fileAction', async (data) => {
			if (!DBBoard.canEdit) return;

			switch (data.action) {
				case 'add': {
					const newFiles = data.files as FileActionData<'add'>['files'];

					this.queuedFiles.update(DBBoard.boardId, (files) =>
						(files ?? []).filter((id) => !newFiles.some((f) => f.id === id)),
					);

					const updated = await this.getRoomData(DBBoard.boardId);
					if (!updated) return;

					const missing = newFiles.filter((f) => !updated.files.includes(f.id));
					if (!missing.length) return;

					updated.files.push(...missing.map((f) => f.id));
					this.roomData.set(DBBoard.boardId, updated);

					await this.manager.files.createFiles(missing, DBBoard.boardId);
					socket.broadcast.to(DBBoard.boardId).emit('filesUpdated');

					updated.elements = updated.elements.map((el) => {
						if (isInitializedImageElement(el)) {
							const f = missing.find((x) => x.id === el.fileId);
							return f ? newElementWith(el, { status: 'saved' }) : el;
						}

						return el;
					});

					this.roomData.set(DBBoard.boardId, updated);
					break;
				}
				case 'remove': {
					const deleted = data.files as FileActionData<'remove'>['files'];
					const existing = this.queuedFiles.get(DBBoard.boardId) || [];

					this.queuedFiles.update(DBBoard.boardId, (files) => [
						...(files ?? []),
						...deleted.filter((file) => !existing.includes(file)),
					]);

					break;
				}
			}
		});
	}

	public async kickUser(boardId: string, userId: string): Promise<string | void> {
		const roomData = this.roomData.get(boardId);
		if (!roomData) return;

		const collaboratorEntry = Array.from(roomData.collaborators.values()).filter((collaborator) => collaborator.id === userId || collaborator.socketId === userId);
		if (!collaboratorEntry.length) return;

		const socketId = collaboratorEntry.find((collaborator) => collaborator.socketId)?.socketId as SocketId;
		if (!socketId) return;

		this.io?.to(socketId).emit('kick');

		setTimeout(() => {
			const socket = this.io?.sockets.sockets.get(socketId);
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
			this.io?.to(boardId).emit('sendSnapshot', data);
		}

		this.io?.to(boardId).emit('isSaved');
	}
}
