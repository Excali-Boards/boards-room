import { recursiveDateConversion } from '../modules/functions.js';
import { TSPrisma } from '@prisma/client';
import { BoardsManager } from '../index.js';

export type IncludesSwitch<
	N extends TSPrisma.AllModelNamesLowercase,
	M extends TSPrisma.AllPrismaMethodsLowercase,
	T extends TSPrisma.AllArgs[N][M],
	I extends boolean = false,
> = I extends true ? TSPrisma.IncludesResult<N, M, T> : TSPrisma.Result<N, M, T>;

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

	try {
		const newArgs = 'select' in args || 'include' in args || !includeAll ? args : TSPrisma.Functions.computeArgs(modelName, operation, args);
		const res = await (instance.prisma[modelName][operation] as TSPrisma.Callable)(newArgs) as never;

		if (typeof res === 'object' && res && 'stack' in res) {
			throw new Error('An error occurred while trying to interact with the database.', {
				cause: res,
			});
		}

		const duration = (Date.now() - startTime) / 1000;
		instance.prometheus.recordDbQuery(modelName, operation, duration);

		return recursiveDateConversion(res) as never;
	} catch (error) {
		const duration = (Date.now() - startTime) / 1000;
		const errorType = error instanceof Error ? error.name : 'unknown';

		instance.prometheus.recordDbError(modelName, operation, errorType);
		instance.prometheus.recordDbQuery(modelName, operation, duration);

		throw error;
	}
}
