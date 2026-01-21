import LoggerModule from '../modules/logger.js';
import { BoardsManager } from '../index.js';
import config from './config.js';
import Valkey from 'iovalkey';

export type DbCacheOptions = {
	cache?: false;
	ttl?: number;
};

export default class CacheService {
	private client: Valkey | null = null;
	private isConnected = false;

	constructor (private readonly manager: BoardsManager) { }

	public async init(): Promise<void> {
		try {
			this.client = new Valkey({
				host: config.valkey.host,
				port: config.valkey.port,
				password: config.valkey.password || undefined,
				db: config.valkey.db,
				maxRetriesPerRequest: 3,
				enableReadyCheck: true,
				enableOfflineQueue: true,
				lazyConnect: false,
				keepAlive: 30000,
				connectTimeout: 10000,
				retryStrategy: (times: number) => {
					if (times > 5) return null;
					return Math.min(times * 3000, 30000);
				},
			});

			this.client.on('connect', () => {
				this.isConnected = true;
				LoggerModule('Cache', 'Connected to Valkey.', 'cyan');
			});

			this.client.on('error', (error) => {
				LoggerModule('Cache', `Error: ${error.message}`, 'red');
				this.manager.prometheus.recordError('cache_error', 'cache');
			});

			this.client.on('close', () => {
				this.isConnected = false;
			});

			await this.client.ping();
			LoggerModule('Cache', 'Valkey ready.', 'green');
		} catch (error) {
			LoggerModule('Cache', `Failed: ${error instanceof Error ? error.message : 'Unknown'}`, 'red');
		}
	}

	public async get<T>(key: string): Promise<T | null> {
		if (!this.isAvailable()) return null;
		try {
			const value = await this.client!.get(key);
			return value ? (JSON.parse(value) as T) : null;
		} catch {
			return null;
		}
	}

	public async set<T>(key: string, value: T, ttl?: number): Promise<void> {
		if (!this.isAvailable()) return;
		try {
			const serialized = JSON.stringify(value);
			const cacheTtl = ttl || config.valkey.ttl;
			await this.client!.setex(key, cacheTtl, serialized);
		} catch (error) {
			LoggerModule('Cache', `Set error: ${error instanceof Error ? error.message : ''}`, 'red');
		}
	}

	public async delete(key: string): Promise<void> {
		if (!this.isAvailable()) return;
		try {
			await this.client!.del(key);
		} catch {
			// *
		}
	}

	public async deletePattern(pattern: string): Promise<void> {
		if (!this.isAvailable()) return;
		try {
			const keys = await this.client!.keys(pattern);
			if (keys.length > 0) await this.client!.del(...keys);
		} catch {
			// *
		}
	}

	public isAvailable(): boolean {
		return this.isConnected && this.client !== null;
	}

	public async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.client.quit();
				LoggerModule('Cache', 'Disconnected', 'cyan');
			} catch {
				// *
			}
		}
	}
}
