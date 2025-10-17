import PrometheusMetrics from './modules/metrics.js';
import { PrismaClient } from '@prisma/client';
import SocketServer from './services/socket.js';
import LoggerModule from './modules/logger.js';
import Routes from './services/routes.js';
import Files from './services/files.js';
import Utils from './modules/utils.js';
import { HonoEnv } from './types.js';
import { Hono } from 'hono';

console.clear();

/* ----------------------------------- Manager ----------------------------------- */

export class BoardsManager {
	public hono = new Hono<HonoEnv>();
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

		await this.routes.init();
		await this.socket.init();
		await this.utils.init();
	}

	private async initPrisma(): Promise<void> {
		await this.prisma.$connect();
		LoggerModule('Prisma', 'Prisma is successfully connected.', 'cyan');
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
