// import { PrismaWithCache, ValKeyCache } from 'prisma-cache-all';
// import { performanceConstants } from './core/constants';
import PrometheusMetrics from './modules/metrics';
import { PrismaClient } from '@prisma/client';
import SocketServer from './services/socket';
import LoggerModule from './modules/logger';
import Routes from './services/routes';
import Files from './services/files';
import Utils from './modules/utils';
import config from './core/config';
import { HonoEnv } from './types';
import ValKey from 'iovalkey';
import { Hono } from 'hono';

console.clear();

/* ----------------------------------- Manager ----------------------------------- */

export class BoardsManager {
	public hono = new Hono<HonoEnv>();
	public valkey = new ValKey(config.valkey);

	public prisma = new PrismaClient();

	public prometheus = new PrometheusMetrics(this);
	public socket = new SocketServer(this);
	public routes = new Routes(this);
	public utils = new Utils(this);
	public files = new Files(this);

	constructor () {
		this.init();
	}

	public async init() {
		await this.initPrisma();

		this.prismaMetrics();

		await this.routes.init();
		await this.socket.init();
		await this.utils.init();
	}

	private async initPrisma(): Promise<void> {
		await this.prisma.$connect();
		LoggerModule('Prisma', 'Prisma is successfully connected.', 'cyan');
	}

	private prismaMetrics(): void {
		// this.prisma.setMetricsCallbacks({
		// 	onCacheHit: (model, action) => this.prometheus.recordDbCacheOperation(model, action, true),
		// 	onCacheMiss: (model, action) => this.prometheus.recordDbCacheOperation(model, action, false),
		// 	onDbRequest: (model, action, durationMs) => this.prometheus.recordDbQuery(model, action, durationMs),
		// 	onDbError: (model, action, error) => this.prometheus.recordDbError(model, action, error.name),
		// 	onCacheSizeUpdate: (size) => this.prometheus.updateDbCacheSize(size),
		// });
	}
}

const manager = new BoardsManager();
export default manager;

/* ----------------------------------- Process ----------------------------------- */

export async function shutdown() {
	await manager.socket.saveAllBoards();
	await manager.prisma.$disconnect();

	LoggerModule('Shutdown', 'All data has been saved and Prisma is disconnected.', 'cyan');
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('beforeExit', shutdown);

process.on('warning', (warning) => console.warn('Warning:', warning));
process.on('uncaughtException', (error) => {
	manager.prometheus.recordError('uncaught_exception', 'process');
	LoggerModule('Process', `Uncaught Exception: ${error.message}`, 'red');
	console.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, promise) => {
	manager.prometheus.recordError('unhandled_rejection', 'process');
	LoggerModule('Process', `Unhandled Rejection: ${reason}`, 'red');
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
