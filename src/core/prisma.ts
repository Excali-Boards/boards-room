import { recursiveDateConversion } from '../modules/functions.js';
import { BoardsManager } from '../index.js';
import { TSPrisma } from '@prisma/client';
import config from './config.js';
import crypto from 'crypto';

export type IncludesSwitch<
	N extends TSPrisma.AllModelNamesLowercase,
	M extends TSPrisma.AllPrismaMethodsLowercase,
	T extends TSPrisma.AllArgs[N][M],
	I extends boolean = false,
> = I extends true ? TSPrisma.IncludesResult<N, M, T> : TSPrisma.Result<N, M, T>;

const readOperations = ['findUnique', 'findFirst', 'findMany', 'count', 'aggregate'] as const;
const writeOperations = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'] as const;

export async function db<
	N extends TSPrisma.AllModelNamesLowercase,
	M extends TSPrisma.AllPrismaMethodsLowercase,
	T extends TSPrisma.AllArgs[N][M],
	I extends boolean = false,
>(
	instance: BoardsManager,
	modelName: N,
	operation: M,
	args: T | TSPrisma.Args<N, M, T>,
	includeAll?: I,
): Promise<IncludesSwitch<N, M, T, I>> {
	const startTime = Date.now();
	const isReadOp = readOperations.includes(operation as never);
	const isWriteOp = writeOperations.includes(operation as never);

	const cacheKey = generateCacheKey(modelName, operation, args);
	const shouldCache = isReadOp && config.valkey.enabled !== false && instance.cache?.isAvailable();

	try {
		if (shouldCache) {
			const cached = await instance.cache.get(cacheKey);
			if (cached !== null) {
				const duration = (Date.now() - startTime) / 1000;
				instance.prometheus.recordDbQuery(modelName, operation, duration);
				return recursiveDateConversion(cached) as never;
			}
		}

		const newArgs = 'select' in args || 'include' in args || !includeAll ? args : TSPrisma.Functions.computeArgs(modelName, operation, args);
		const res = await (instance.prisma[modelName][operation] as TSPrisma.Callable)(newArgs) as never;

		if (typeof res === 'object' && res && 'stack' in res) {
			throw new Error('An error occurred while trying to interact with the database.', {
				cause: res,
			});
		}

		const duration = (Date.now() - startTime) / 1000;
		instance.prometheus.recordDbQuery(modelName, operation, duration);

		if (shouldCache) await instance.cache.set(cacheKey, res, config.valkey.defaultTtl);
		if (isWriteOp && instance.cache?.isAvailable()) await invalidateCacheForWrite(instance, modelName);

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
		board: ['category', 'group', 'file', 'boardPermission'],
		category: ['group', 'board', 'categoryPermission'],
		group: ['category', 'board', 'groupPermission'],
		user: ['session', 'groupPermission', 'categoryPermission', 'boardPermission'],
		session: ['user'],
		boardPermission: ['board', 'user'],
		categoryPermission: ['category', 'user'],
		groupPermission: ['group', 'user'],
	};

	return relations[modelName] || [];
}
