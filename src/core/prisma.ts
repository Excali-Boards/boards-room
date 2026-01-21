import { recursiveDateConversion } from '../modules/functions.js';
import { BoardsManager } from '../index.js';
import { TSPrisma } from '@prisma/client';
import config from './config.js';
import crypto from 'crypto';

const readOperations = ['findUnique', 'findFirst', 'findMany', 'count', 'aggregate'] as const;
const writeOperations = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'] as const;

export async function db<
	N extends TSPrisma.AllModelNamesLowercase,
	M extends TSPrisma.AllPrismaMethodsLowercase,
	T extends TSPrisma.AllArgs[N][M],
>(
	instance: BoardsManager,
	modelName: N,
	operation: M,
	args: T | TSPrisma.Args<N, M, T>,
): Promise<TSPrisma.Result<N, M, T>> {
	const startTime = Date.now();
	const isReadOp = readOperations.includes(operation as never);
	const isWriteOp = writeOperations.includes(operation as never);

	const cacheKey = generateCacheKey(modelName, operation, args);
	const shouldCache = isReadOp && instance.cache.isAvailable();

	try {
		if (shouldCache) {
			const cached = await instance.cache.get(cacheKey);
			if (cached !== null) {
				const duration = (Date.now() - startTime) / 1000;
				instance.prometheus.recordDbQuery(modelName, operation, duration);
				return recursiveDateConversion(cached) as never;
			}
		}

		const res = await (instance.prisma[modelName][operation] as TSPrisma.Callable)(args) as never;
		if (typeof res === 'object' && res && 'stack' in res) {
			throw new Error('An error occurred while trying to interact with the database.', {
				cause: res,
			});
		}

		const duration = (Date.now() - startTime) / 1000;
		instance.prometheus.recordDbQuery(modelName, operation, duration);

		if (shouldCache) await instance.cache.set(cacheKey, res, config.valkey.ttl);
		if (isWriteOp && instance.cache.isAvailable()) await invalidateCacheForWrite(instance, modelName);

		return recursiveDateConversion(res) as never;
	} catch (error) {
		const duration = (Date.now() - startTime) / 1000;
		const errorType = error instanceof Error ? error.name : 'unknown';

		instance.prometheus.recordDbError(modelName, operation, errorType);
		instance.prometheus.recordDbQuery(modelName, operation, duration);

		throw error;
	}
}


export function generateCacheKey(modelName: string, operation: string, args: unknown): string {
	const normalized = JSON.stringify({ modelName, operation, args });
	const hash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
	return `db:${modelName}:${operation}:${hash}`;
}

export async function invalidateCacheForWrite(instance: BoardsManager, modelName: string): Promise<void> {
	await instance.cache.deletePattern(`db:${modelName}:*`);

	const relations = getModelRelations(modelName);
	for (const relatedModel of relations) {
		await instance.cache.deletePattern(`db:${relatedModel}:*`);
	}
}

export function getModelRelations(modelName: string): string[] {
	const relations: Record<string, string[]> = {
		// Core entities
		user: ['session', 'loginMethod', 'groupPermission', 'categoryPermission', 'boardPermission', 'userBoardActivity', 'event', 'invite', 'deckProgress'],
		session: ['user'],
		loginMethod: ['user'],

		// Hierarchy: Group -> Category -> Board
		group: ['category', 'groupPermission', 'event'],
		category: ['group', 'board', 'categoryPermission'],
		board: ['category', 'file', 'boardPermission', 'userBoardActivity', 'flashcardDeck'],

		// Permissions
		groupPermission: ['group', 'user'],
		categoryPermission: ['category', 'user'],
		boardPermission: ['board', 'user'],

		// Files and activities
		file: ['board'],
		userBoardActivity: ['user', 'board'],

		// Events/Calendar
		event: ['group', 'user'],

		// Flashcards
		flashcardDeck: ['board', 'flashcardCard', 'deckProgress'],
		flashcardCard: ['flashcardDeck'],
		deckProgress: ['flashcardDeck', 'user'],

		// Invites
		invite: ['user'],
	};

	return relations[modelName] || [];
}
