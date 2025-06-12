import { recursiveDateConversion } from '../modules/utils';
import { TSPrisma } from '@prisma/client';
import { BoardsManager } from '../index';

export type HasSelect<
	N extends TSPrisma.AllModelNamesLowercase,
	M extends TSPrisma.AllPrismaMethodsLowercase,
	T extends TSPrisma.AllArgs[N][M],
> = 'select' extends keyof T
	? T['select'] extends Record<string, unknown>
		? true
		: false
	: false;

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
): Promise<(HasSelect<N, M, T> extends true ? TSPrisma.Result<N, M, T> : I extends true ? TSPrisma.IncludesResult<N, M, T> : TSPrisma.Result<N, M, T>) | null> {
	const newArgs = 'select' in args ? args : includeAll ? TSPrisma.Functions.computeArgs(modelName, operation, args) : args;
	const res = await (instance.prisma.client[modelName][operation] as TSPrisma.Callable)(newArgs) as never;

	if (typeof res === 'object' && res && 'stack' in res) {
		throw new Error('An error occurred while trying to interact with the database.', {
			cause: res,
		});
	}

	return recursiveDateConversion(res) as never;
}
