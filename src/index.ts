import { Prisma, LRUCache } from 'prisma-cache-all';
import SocketServer from './classes/socket';
import LoggerModule from './modules/logger';
import Routes from './classes/routes';
import Utils from './classes/utils';
import Files from './classes/files';
import { HonoEnv } from './types';
import { Hono } from 'hono';

console.clear();

/* ----------------------------------- Manager ----------------------------------- */

export class BoardsManager {
	public hono = new Hono<HonoEnv>();
	public prisma = new Prisma(new LRUCache({
		ttlAutopurge: true,
		ttlSeconds: 60 * 60 * 24,
	}));

	public utils = new Utils(this);
	public files = new Files(this);
	public routes = new Routes(this);
	public socket = new SocketServer(this);

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
		await this.prisma.client.$connect();
		LoggerModule('Prisma', 'Prisma is successfully connected.', 'cyan');
	}
}

const manager = new BoardsManager();
export default manager;

/* ----------------------------------- Process ----------------------------------- */

export async function shutdown() {
	await manager.socket.saveAllBoards();
	await manager.prisma.client.$disconnect();

	LoggerModule('Shutdown', 'All data has been saved and Prisma is disconnected.', 'cyan');
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('beforeExit', shutdown);

process.on('warning', (warning) => console.warn('Warning:', warning));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));
