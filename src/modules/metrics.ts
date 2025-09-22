import { Counter, Gauge, Histogram, register } from 'prom-client';
import { monitoringConstants } from '../core/constants';
import { RouteMethod, SystemStatus } from '../types';
import { MiddlewareHandler } from 'hono';
import { BoardsManager } from '../index';
import { routePath } from 'hono/route';
import LoggerModule from './logger';
import { db } from '../core/prisma';
import pidusage from 'pidusage';

export class MetricsBase {
	// -------------------- HTTP Metrics --------------------
	protected httpRequests = new Counter({
		name: 'boards_http_requests_total',
		help: 'Total number of HTTP requests',
		labelNames: ['method', 'route', 'status_code'],
	});

	protected httpRequestDuration = new Histogram({
		name: 'boards_http_request_duration_seconds',
		help: 'Duration of HTTP requests in seconds',
		labelNames: ['method', 'route', 'status_code'],
		buckets: [0.1, 0.5, 1, 2, 5],
	});

	// -------------------- Socket Metrics --------------------
	protected socketConnections = new Gauge({
		name: 'boards_socket_connections_current',
		help: 'Current number of socket connections',
	});

	protected activeRooms = new Gauge({
		name: 'boards_active_rooms_current',
		help: 'Current number of active rooms',
	});

	protected socketEvents = new Counter({
		name: 'boards_socket_events_total',
		help: 'Total number of socket events',
		labelNames: ['event'],
	});

	// -------------------- Database Metrics --------------------
	protected dbQueries = new Counter({
		name: 'boards_database_queries_total',
		help: 'Total number of database queries executed',
		labelNames: ['operation', 'table'],
	});

	protected dbQueryDuration = new Histogram({
		name: 'boards_database_query_duration_seconds',
		help: 'Duration of database queries in seconds',
		labelNames: ['operation', 'table'],
		buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
	});

	protected dbErrors = new Counter({
		name: 'boards_database_errors_total',
		help: 'Total number of database errors',
		labelNames: ['operation', 'table', 'error_type'],
	});

	// -------------------- Essential System Metrics --------------------
	protected memoryUsage = new Gauge({
		name: 'boards_memory_usage_bytes',
		help: 'Memory usage in bytes',
		labelNames: ['type'],
	});

	protected cpuUsage = new Gauge({
		name: 'boards_cpu_usage_percentage',
		help: 'CPU usage percentage',
	});

	// -------------------- File Operation Metrics --------------------
	protected fileOperations = new Counter({
		name: 'boards_file_operations_total',
		help: 'Total number of file operations',
		labelNames: ['operation', 'status'],
	});

	// -------------------- Error Metrics --------------------
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
				{ path: '/sessions', method: 'POST' },
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
				this.httpRequestDuration.observe({ method: c.req.method, route }, durationSec);
			}
		};
	}

	public async getMetrics(): Promise<string> {
		return await register.metrics();
	}
}

export default class PrometheusMetrics extends MetricsBase {
	public systemStatusData: SystemStatus | null = null;

	constructor (private manager: BoardsManager) {
		super();

		getSystemMetrics(manager).then((status) => {
			this.systemStatusData = status;
		});
	}

	private async getSystemStatus(): Promise<void> {
		this.systemStatusData = await getSystemMetrics(this.manager);
		setInterval(() => this.getSystemStatus(), monitoringConstants.systemStatusUpdateIntervalMs);
	}

	public recordDbQuery(table: string, operation: string, durationSec: number) {
		this.dbQueries.inc({ operation, table });
		this.dbQueryDuration.observe({ operation, table }, durationSec);
	}

	public recordDbError(table: string, operation: string, errorType: string) {
		this.dbErrors.inc({ operation, table, error_type: errorType });
	}

	public recordFileOperation(operation: string, status: 'success' | 'error'): void {
		this.fileOperations.inc({ operation, status });
	}

	public recordError(type: string, source: string): void {
		this.errors.inc({ type, source });
	}

	public updateSocketMetrics(connections: number, rooms: number): void {
		this.socketConnections.set(connections);
		this.activeRooms.set(rooms);
	}

	public recordSocketEvent(event: string): void {
		this.socketEvents.inc({ event });
	}
}

// Functions.
export async function getSystemMetrics(manager: BoardsManager): Promise<SystemStatus> {
	const memUsage = process.memoryUsage();
	const stats = await pidusage(process.pid);

	return {
		cpuUsage: parseFloat(stats.cpu.toFixed(2)),
		memoryUsage: (memUsage.rss / (1024 * 1024)).toFixed(2) + ' MB',

		activeRooms: manager.socket.roomData.size,
		socketConnections: manager.socket.io.sockets.sockets.size,
		queuedFiles: manager.socket.queuedFiles.size,

		totalUsers: await db(manager, 'user', 'count', {}) || 0,
		totalInvites: await db(manager, 'invite', 'count', {}) || 0,

		totalBoards: await db(manager, 'board', 'count', {}) || 0,
		totalCategories: await db(manager, 'category', 'count', {}) || 0,
		totalGroups: await db(manager, 'group', 'count', {}) || 0,
	};
}
