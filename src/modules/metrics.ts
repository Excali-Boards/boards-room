import { PresenceState, RouteMethod, SystemStatus } from '../types.js';
import { Counter, Gauge, Histogram, register } from 'prom-client';
import { monitoringConstants } from '../core/constants.js';
import { BoardsManager } from '../index.js';
import { MiddlewareHandler } from 'hono';
import LoggerModule from './logger.js';
import { routePath } from 'hono/route';
import { db } from '../core/prisma.js';
import pidusage from 'pidusage';

export type UserActivitySession = {
	userId: string;
	boardId: string;
	socketId: string;
	joinedAt: number;
	lastActivityAt: number;
	lastPersistedAt: number;
	presenceState: PresenceState;
	lastStateAt: number;
	activeMsTotal: number;
	activeMsSincePersist: number;
};

export class MetricsBase {
	protected httpRequests = new Counter({
		name: 'boards_http_requests_total',
		help: 'Total number of HTTP requests',
		labelNames: ['method', 'route', 'status_code'],
	});

	protected httpRequestDuration = new Histogram({
		name: 'boards_http_request_duration_seconds',
		help: 'Duration of HTTP requests in seconds',
		labelNames: ['method', 'route', 'status_code'],
		buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	});

	protected socketConnectionsActive = new Gauge({
		name: 'boards_socket_connections_active',
		help: 'Current number of active socket connections',
	});

	protected socketConnectionDuration = new Histogram({
		name: 'boards_socket_connection_duration_seconds',
		help: 'Duration of socket connections in seconds',
		buckets: [10, 30, 60, 300, 600, 1800, 3600, 7200, 14400],
	});

	protected userActiveSessions = new Gauge({
		name: 'boards_user_active_sessions',
		help: 'Current number of active user sessions per board',
		labelNames: ['board_id'],
	});

	protected userSessionDuration = new Histogram({
		name: 'boards_user_session_duration_seconds',
		help: 'Duration of user sessions',
		labelNames: ['user_id', 'board_id'],
		buckets: [30, 60, 300, 600, 1800, 3600, 7200, 14400],
	});

	protected boardActiveRooms = new Gauge({
		name: 'boards_active_rooms',
		help: 'Current number of active board rooms',
	});

	protected boardCollaborators = new Gauge({
		name: 'boards_collaborators_current',
		help: 'Current number of collaborators per board',
		labelNames: ['board_id'],
	});

	protected dbQueries = new Counter({
		name: 'boards_database_queries_total',
		help: 'Total number of database queries',
		labelNames: ['operation', 'table'],
	});

	protected dbQueryDuration = new Histogram({
		name: 'boards_database_query_duration_seconds',
		help: 'Duration of database queries in seconds',
		labelNames: ['operation', 'table'],
		buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
	});

	protected dbErrors = new Counter({
		name: 'boards_database_errors_total',
		help: 'Total number of database errors',
		labelNames: ['operation', 'table', 'error_type'],
	});

	protected fileOperations = new Counter({
		name: 'boards_file_operations_total',
		help: 'Total number of file operations',
		labelNames: ['operation', 'status'],
	});

	protected memoryUsage = new Gauge({
		name: 'boards_memory_usage_bytes',
		help: 'Memory usage in bytes',
		labelNames: ['type'],
	});

	protected cpuUsage = new Gauge({
		name: 'boards_cpu_usage_percentage',
		help: 'CPU usage percentage',
	});

	protected errors = new Counter({
		name: 'boards_errors_total',
		help: 'Total number of errors',
		labelNames: ['type', 'source'],
	});

	constructor () {
		setInterval(() => this.collectSystemMetrics(), monitoringConstants.metricsCollectionIntervalMs);
		LoggerModule('Metrics', 'Metrics collection started.', 'green');
	}

	private async collectSystemMetrics(): Promise<void> {
		const memUsage = process.memoryUsage();
		this.memoryUsage.set({ type: 'heap_used' }, memUsage.heapUsed);
		this.memoryUsage.set({ type: 'heap_total' }, memUsage.heapTotal);
		this.memoryUsage.set({ type: 'external' }, memUsage.external);
		this.memoryUsage.set({ type: 'rss' }, memUsage.rss);

		const stats = await pidusage(process.pid);
		this.cpuUsage.set(stats.cpu);
	}

	public metricsMiddleware(): MiddlewareHandler {
		return async (c, next) => {
			const ignoredRoutes: { path: string; method: RouteMethod | 'ANY'; }[] = [
				{ path: '/', method: 'ANY' },
				{ path: '/info/metrics', method: 'ANY' },
			];

			if (ignoredRoutes.some((route) => route.path === c.req.routePath && route.method === c.req.method)) return next();

			const start = Date.now();
			try {
				await next();
			} finally {
				const durationSec = (Date.now() - start) / 1000;
				const route = routePath(c) || c.req.path;

				this.httpRequests.inc({ method: c.req.method, route, status_code: c.res.status.toString() });
				this.httpRequestDuration.observe({ method: c.req.method, route, status_code: c.res.status.toString() }, durationSec);
			}
		};
	}

	public async getMetrics(): Promise<string> {
		return await register.metrics();
	}
}

export default class PrometheusMetrics extends MetricsBase {
	private activeSessions = new Map<string, UserActivitySession>();
	private persistInterval: NodeJS.Timeout | null = null;
	public systemStatusData: SystemStatus | null = null;

	constructor (private manager: BoardsManager) {
		super();

		getSystemMetrics(manager).then((status) => {
			this.systemStatusData = status;
		});

		this.startActivityPersistence();
	}

	private async getSystemStatus(): Promise<void> {
		this.systemStatusData = await getSystemMetrics(this.manager);
		setInterval(() => this.getSystemStatus(), monitoringConstants.systemStatusUpdateIntervalMs);
	}

	public recordDbQuery(table: string, operation: string, durationSec: number): void {
		this.dbQueries.inc({ operation, table });
		this.dbQueryDuration.observe({ operation, table }, durationSec);
	}

	public recordDbError(table: string, operation: string, errorType: string): void {
		this.dbErrors.inc({ operation, table, error_type: errorType });
	}

	public recordFileOperation(operation: string, status: 'success' | 'error'): void {
		this.fileOperations.inc({ operation, status });
	}

	public recordError(type: string, source: string): void {
		this.errors.inc({ type, source });
	}

	public updateSocketMetrics(connections: number, rooms: number): void {
		this.socketConnectionsActive.set(connections);
		this.boardActiveRooms.set(rooms);
	}

	public recordSocketConnectionDuration(durationSeconds: number): void {
		this.socketConnectionDuration.observe(durationSeconds);
	}

	public startUserSession(userId: string, boardId: string, socketId: string): void {
		const now = Date.now();

		this.activeSessions.set(socketId, {
			userId,
			boardId,
			socketId,
			joinedAt: now,
			lastActivityAt: now,
			lastPersistedAt: now,
			presenceState: 'active',
			lastStateAt: now,
			activeMsTotal: 0,
			activeMsSincePersist: 0,
		});

		const boardSessions = Array.from(this.activeSessions.values()).filter((s) => s.boardId === boardId).length;
		this.userActiveSessions.set({ board_id: boardId }, boardSessions);

		const boardCollaborators = new Set(Array.from(this.activeSessions.values()).filter((s) => s.boardId === boardId).map((s) => s.userId)).size;
		this.boardCollaborators.set({ board_id: boardId }, boardCollaborators);
	}

	public recordUserAction(socketId: string): void {
		this.updateUserPresence(socketId, 'active');
	}

	public updateUserPresence(socketId: string, nextState: PresenceState): void {
		const session = this.activeSessions.get(socketId);
		if (!session) return;

		const now = Date.now();
		if (session.presenceState === nextState) {
			if (nextState === 'active') session.lastActivityAt = now;
			return;
		}

		if (session.presenceState === 'active') {
			const activeDelta = now - session.lastStateAt;
			session.activeMsTotal += activeDelta;
			session.activeMsSincePersist += activeDelta;
		}

		session.presenceState = nextState;
		session.lastStateAt = now;
		if (nextState === 'active') session.lastActivityAt = now;
	}

	public async endUserSession(socketId: string): Promise<void> {
		const session = this.activeSessions.get(socketId);
		if (!session) return;

		const now = Date.now();
		if (session.presenceState === 'active') {
			const activeDelta = now - session.lastStateAt;
			session.activeMsTotal += activeDelta;
			session.activeMsSincePersist += activeDelta;
			session.lastStateAt = now;
		}

		const durationSeconds = Math.floor(session.activeMsTotal / 1000);
		const durationDeltaSeconds = Math.floor(session.activeMsSincePersist / 1000);

		this.userSessionDuration.observe({ user_id: session.userId, board_id: session.boardId }, durationSeconds);

		const remainingBoardSessions = Array.from(this.activeSessions.values()).filter((s) => s.boardId === session.boardId && s.socketId !== socketId).length;
		this.userActiveSessions.set({ board_id: session.boardId }, remainingBoardSessions);

		const remainingCollaborators = new Set(Array.from(this.activeSessions.values()).filter((s) => s.boardId === session.boardId && s.socketId !== socketId).map((s) => s.userId)).size;
		this.boardCollaborators.set({ board_id: session.boardId }, remainingCollaborators);

		await this.persistSessionToDb(session, durationSeconds, durationDeltaSeconds);
		this.activeSessions.delete(socketId);
	}

	private async persistSessionToDb(session: UserActivitySession, totalDurationSeconds: number, durationDeltaSeconds: number): Promise<void> {
		try {
			await db(this.manager, 'userBoardActivity', 'upsert', {
				where: {
					userId_boardId: {
						userId: session.userId,
						boardId: session.boardId,
					},
				},
				create: {
					userId: session.userId,
					boardId: session.boardId,
					totalSessions: 1,
					totalActiveSeconds: totalDurationSeconds,
					lastActivityAt: new Date(session.lastActivityAt),
				},
				update: {
					totalSessions: { increment: 1 },
					totalActiveSeconds: { increment: durationDeltaSeconds },
					lastActivityAt: new Date(session.lastActivityAt),
				},
			});
		} catch (error) {
			this.recordError('activity_persistence', 'metrics');
			LoggerModule('Metrics', `Error persisting user activity: ${error}`, 'red');
		}
	}

	private startActivityPersistence(): void {
		this.persistInterval = setInterval(() => { this.persistActiveSessions(); }, 60 * 1000);
		LoggerModule('Metrics', 'Activity persistence started.', 'green');
	}

	private async persistActiveSessions(): Promise<void> {
		const sessions = Array.from(this.activeSessions.values());
		if (!sessions.length) return;

		for (const session of sessions) {
			try {
				const now = Date.now();
				if (session.presenceState === 'active') {
					const activeDelta = now - session.lastStateAt;
					session.activeMsTotal += activeDelta;
					session.activeMsSincePersist += activeDelta;
					session.lastStateAt = now;
				}

				const durationDeltaSeconds = Math.floor(session.activeMsSincePersist / 1000);

				session.lastPersistedAt = now;
				session.activeMsSincePersist = 0;

				if (durationDeltaSeconds <= 0) continue;

				await db(this.manager, 'userBoardActivity', 'upsert', {
					where: {
						userId_boardId: {
							userId: session.userId,
							boardId: session.boardId,
						},
					},
					create: {
						userId: session.userId,
						boardId: session.boardId,
						totalSessions: 0,
						totalActiveSeconds: durationDeltaSeconds,
						lastActivityAt: new Date(session.lastActivityAt),
					},
					update: {
						totalActiveSeconds: { increment: durationDeltaSeconds },
						lastActivityAt: new Date(session.lastActivityAt),
					},
				});
			} catch (error) {
				this.recordError('activity_persistence', 'metrics');
				LoggerModule('Metrics', `Error persisting active session state: ${error}`, 'red');
			}
		}
	}

	public async shutdown(): Promise<void> {
		if (this.persistInterval) clearInterval(this.persistInterval);
		await this.persistActiveSessions();

		const sessions = Array.from(this.activeSessions.keys());
		for (const socketId of sessions) await this.endUserSession(socketId);

		LoggerModule('Metrics', 'Metrics system shutdown complete.', 'yellow');
	}

	public getActiveSessions(): UserActivitySession[] {
		return Array.from(this.activeSessions.values());
	}
}

// Functions.
export async function getSystemMetrics(manager: BoardsManager): Promise<SystemStatus> {
	const memUsage = process.memoryUsage();
	const stats = await pidusage(process.pid);

	return {
		cpuUsage: parseFloat(stats.cpu.toFixed(2)),
		memoryUsage: (memUsage.rss / (1024 * 1024)).toFixed(2) + ' MB',

		activeRooms: manager.socket.excalidrawSocket.roomData.size + manager.socket.tldrawSocket.roomData.size,
		socketConnections: manager.socket.io.sockets.sockets.size,
		queuedFiles: manager.socket.excalidrawSocket.queuedFiles.size + manager.socket.tldrawSocket.queuedFiles.size,

		totalUsers: await db(manager, 'user', 'count', {}) || 0,
		totalInvites: await db(manager, 'invite', 'count', {}) || 0,

		totalBoards: await db(manager, 'board', 'count', {}) || 0,
		totalCategories: await db(manager, 'category', 'count', {}) || 0,
		totalGroups: await db(manager, 'group', 'count', {}) || 0,
	};
}
