import LoggerModule from '../modules/logger.js';
import { BoardsManager } from '../index.js';
import config from './config.js';
import Valkey from 'iovalkey';

export type DbCacheOptions = {
	cache?: false;
	ttl?: number;
};

type QrChallengeDecision = 'approve' | 'deny';

type CreateQrChallengeInput = {
	challengeKey: string;
	codeKey: string;
	userCode: string;
	expiresAt: number;
	requestDevice: string;
	deviceHash: string;
	ttlSeconds: number;
};

type DecideQrChallengeInput = {
	codeKey: string;
	challengeKey: string;
	deviceHash: string;
	decision: QrChallengeDecision;
	userId: string;
	sessionToken: string;
	sessionExpiresAt: number;
	qrLoginRedirectDelay: boolean;
	now: number;
};

const createQrChallengeScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[5], 'NX') == false then return 0 end
redis.call('HSET', KEYS[1], 'status', 'pending', 'userCode', ARGV[1], 'expiresAt', ARGV[2], 'requestDevice', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;

const decideQrChallengeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[6] or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
local status = redis.call('HGET', KEYS[2], 'status')
local expiresAt = tonumber(redis.call('HGET', KEYS[2], 'expiresAt') or '0')
if status ~= 'pending' or expiresAt <= tonumber(ARGV[1]) then return 0 end
if ARGV[2] == 'approve' then
  redis.call('HSET', KEYS[2], 'status', 'approved', 'approvedByUserId', ARGV[3], 'sessionToken', ARGV[4], 'sessionExpiresAt', ARGV[5], 'qrLoginRedirectDelay', ARGV[7])
else
  redis.call('HSET', KEYS[2], 'status', 'denied')
end
return 1
`;

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

	public async getRaw(key: string): Promise<string | null> {
		if (!this.isAvailable()) return null;
		try {
			return await this.client!.get(key);
		} catch {
			return null;
		}
	}

	public async getHash(key: string): Promise<Record<string, string> | null> {
		if (!this.isAvailable()) return null;
		try {
			const value = await this.client!.hgetall(key);
			return Object.keys(value).length ? value : null;
		} catch {
			return null;
		}
	}

	public async getRawStrict(key: string): Promise<string | null> {
		if (!this.isAvailable()) throw new Error('Cache unavailable.');
		try {
			return await this.client!.get(key);
		} catch {
			throw new Error('Cache unavailable.');
		}
	}

	public async getHashStrict(key: string): Promise<Record<string, string> | null> {
		if (!this.isAvailable()) throw new Error('Cache unavailable.');
		try {
			const value = await this.client!.hgetall(key);
			return Object.keys(value).length ? value : null;
		} catch {
			throw new Error('Cache unavailable.');
		}
	}

	public async createQrChallenge(input: CreateQrChallengeInput): Promise<boolean> {
		if (!this.isAvailable()) throw new Error('Cache unavailable.');
		try {
			const result = await this.client!.eval(
				createQrChallengeScript,
				2,
				input.challengeKey,
				input.codeKey,
				input.userCode,
				String(input.expiresAt),
				input.requestDevice,
				input.deviceHash,
				String(input.ttlSeconds),
			);
			return Number(result) === 1;
		} catch {
			throw new Error('Cache unavailable.');
		}
	}

	public async decideQrChallenge(input: DecideQrChallengeInput): Promise<boolean> {
		if (!this.isAvailable()) throw new Error('Cache unavailable.');
		try {
			const result = await this.client!.eval(
				decideQrChallengeScript,
				2,
				input.codeKey,
				input.challengeKey,
				String(input.now),
				input.decision,
				input.userId,
				input.sessionToken,
				String(input.sessionExpiresAt),
				input.deviceHash,
				String(input.qrLoginRedirectDelay),
			);
			return Number(result) === 1;
		} catch {
			throw new Error('Cache unavailable.');
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
			let cursor = '0';
			do {
				const [nextCursor, keys] = await this.client!.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
				cursor = nextCursor;
				if (keys.length > 0) await this.client!.del(...keys);
			} while (cursor !== '0');
		} catch {
			// *
		}
	}

	public async increment(key: string, ttlSeconds: number): Promise<number | null> {
		if (!this.isAvailable()) return null;
		try {
			const count = await this.client!.eval(
				'local current = redis.call("INCR", KEYS[1]); if current == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return current;',
				1,
				key,
				ttlSeconds,
			);
			return typeof count === 'number' ? count : Number(count);
		} catch {
			return null;
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
