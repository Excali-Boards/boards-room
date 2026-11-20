import { getBoardAccessLevel } from '../other/permissions.js';
import { makeSearchTokenHashes, type BoardSearchMatch, type StoredSearchItem } from '../services/search.js';
import { compressionUtils } from '../modules/functions.js';
import { json, makeRoute } from '../services/routes.js';
import config from '../core/config.js';
import manager from '../index.js';
import type { Prisma } from '@prisma/client';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TOKENS = 12;
const SEARCH_CHUNK_BATCH_SIZE = 32;
const MAX_RESPONSE_MATCHES = 20;

type SearchCursor = {
	boardId: string;
};

const encodeCursor = (cursor: SearchCursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (value: string | undefined): SearchCursor | null => {
	if (!value) return null;

	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SearchCursor>;
		if (typeof parsed.boardId !== 'string' || !parsed.boardId) return null;
		return { boardId: parsed.boardId };
	} catch {
		return null;
	}
};

const tokenizeQuery = (query: string): string[] => Array.from(new Set(
	(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])
		.filter((token) => token.length >= 2)
		.slice(0, MAX_QUERY_TOKENS),
));

const deserializeChunk = (payload: Uint8Array): StoredSearchItem[] => {
	try {
		const parsed = compressionUtils.decompressAndDecrypt<unknown>(Buffer.from(payload));
		return Array.isArray(parsed) ? parsed as StoredSearchItem[] : [];
	} catch {
		return [];
	}
};

const itemMatches = (item: StoredSearchItem, tokenHashes: readonly number[], queryTokens: readonly string[]): boolean => {
	if (!Array.isArray(item.tokenHashes)) return false;

	const itemTokens = new Set(item.tokenHashes);
	if (!tokenHashes.every((tokenHash) => itemTokens.has(tokenHash))) return false;

	const words = item.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
	return queryTokens.every((token) => words.some((word) => word.startsWith(token)));
};

const boardNameMatches = (name: string, queryTokens: readonly string[]): boolean => {
	const words = name.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
	return queryTokens.every((token) => words.some((word) => word.startsWith(token)));
};

const compareSearchMatches = (first: BoardSearchMatch, second: BoardSearchMatch): number => {
	const firstHasPosition = typeof first.x === 'number' && typeof first.y === 'number';
	const secondHasPosition = typeof second.x === 'number' && typeof second.y === 'number';
	if (firstHasPosition !== secondHasPosition) return firstHasPosition ? -1 : 1;
	if (!firstHasPosition || !secondHasPosition) return first.elementId.localeCompare(second.elementId);

	const xDifference = second.x! - first.x!;
	if (Math.abs(xDifference) > 32) return xDifference;

	const yDifference = first.y! - second.y!;
	return yDifference || first.elementId.localeCompare(second.elementId);
};

export default [
	makeRoute({
		path: '/search',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!config.globalSearchEnabled) return json(c, 404, { error: 'Global board search is disabled.' });

			const query = (c.req.query('q') || '').trim();
			if (query.length < 2) return json(c, 400, { error: 'Search query must contain at least 2 characters.' });
			if (query.length > MAX_QUERY_LENGTH) return json(c, 400, { error: 'Search query must not exceed ' + MAX_QUERY_LENGTH + ' characters.' });

			const queryTokens = tokenizeQuery(query);
			if (queryTokens.length === 0) return json(c, 400, { error: 'Search query does not contain searchable characters.' });

			const tokenHashes = makeSearchTokenHashes(queryTokens.join(' '));
			if (tokenHashes.length === 0) return json(c, 400, { error: 'Search query does not contain searchable characters.' });

			const parsedLimit = Number.parseInt(c.req.query('limit') || String(DEFAULT_LIMIT), 10);
			const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
			const cursorValue = c.req.query('cursor');
			const cursor = decodeCursor(cursorValue);
			if (cursorValue && !cursor) return json(c, 400, { error: 'Invalid search cursor.' });

			const groupIds = c.var.DBUser.groupPermissions.map((permission) => permission.groupId);
			const categoryIds = c.var.DBUser.categoryPermissions.map((permission) => permission.categoryId);
			const boardIds = c.var.DBUser.boardPermissions.map((permission) => permission.boardId);
			const accessConditions: Prisma.BoardWhereInput[] = [];

			if (groupIds.length > 0) accessConditions.push({ category: { groupId: { in: groupIds } } });
			if (categoryIds.length > 0) accessConditions.push({ categoryId: { in: categoryIds } });
			if (boardIds.length > 0) accessConditions.push({ boardId: { in: boardIds } });

			const accessWhere: Prisma.BoardWhereInput = c.var.isDev
				? {}
				: accessConditions.length > 0
					? { OR: accessConditions }
					: { boardId: { in: [] } };

			const boardWhere: Prisma.BoardWhereInput = {
				AND: [
					accessWhere,
					...(config.personalBoardsEnabled ? [] : [{ category: { group: { kind: 'Shared' as const } } }]),
				],
			};

			const chunkWhere: Prisma.BoardSearchChunkWhereInput = {
				tokenHashes: { hasEvery: tokenHashes },
			};

			const searchWhere: Prisma.BoardSearchIndexWhereInput = {
				AND: [
					{ board: boardWhere },
					{
						OR: [
							{ nameTokenHashes: { hasEvery: tokenHashes } },
							{ chunks: { some: chunkWhere } },
						],
					},
					...(cursor ? [{ boardId: { gt: cursor.boardId } }] : []),
				],
			};

			const rows = await manager.prisma.boardSearchIndex.findMany({
				where: searchWhere,
				orderBy: { boardId: 'asc' },
				take: limit + 1,
				select: {
					boardId: true,
					dbId: true,
					updatedAt: true,
					board: {
						select: {
							name: true,
							type: true,
							category: {
								select: {
									categoryId: true,
									name: true,
									group: {
										select: {
											groupId: true,
											name: true,
											kind: true,
											ownerId: true,
										},
									},
								},
							},
						},
					},
				},
			});

			const hasMore = rows.length > limit;
			const resultRows = hasMore ? rows.slice(0, limit) : rows;
			const results = [];
			for (const row of resultRows) {
				const matchesById = new Map<string, BoardSearchMatch>();
				const boardMatchesByName = boardNameMatches(row.board.name, queryTokens);

				if (!boardMatchesByName) {
					let lastChunkId: number | undefined;

					while (matchesById.size < MAX_RESPONSE_MATCHES) {
						const chunks = await manager.prisma.boardSearchChunk.findMany({
							where: {
								boardSearchIndexId: row.dbId,
								...chunkWhere,
								...(lastChunkId === undefined ? {} : { chunkId: { gt: lastChunkId } }),
							},
							orderBy: { chunkId: 'asc' },
							take: SEARCH_CHUNK_BATCH_SIZE,
							select: { chunkId: true, payload: true },
						});

						for (const chunk of chunks) {
							for (const item of deserializeChunk(chunk.payload)) {
								if (!itemMatches(item, tokenHashes, queryTokens) || matchesById.has(item.elementId)) continue;
								matchesById.set(item.elementId, {
									elementId: item.elementId,
									text: item.text,
									...(item.x === undefined ? {} : { x: item.x }),
									...(item.y === undefined ? {} : { y: item.y }),
									...(item.pageId ? { pageId: item.pageId } : {}),
								});

								if (matchesById.size >= MAX_RESPONSE_MATCHES) break;
							}

							if (matchesById.size >= MAX_RESPONSE_MATCHES) break;
						}

						if (chunks.length < SEARCH_CHUNK_BATCH_SIZE) break;
						lastChunkId = chunks[chunks.length - 1]!.chunkId;
					}
				}

				if (!boardMatchesByName && matchesById.size === 0) continue;

				results.push({
					board: {
						id: row.boardId,
						name: row.board.name,
						type: row.board.type,
						accessLevel: getBoardAccessLevel(
							c.var.DBUser,
							row.boardId,
							row.board.category.categoryId,
							row.board.category.group.groupId,
						),
					},
					group: {
						id: row.board.category.group.groupId,
						name: row.board.category.group.name,
						kind: row.board.category.group.kind,
						ownerId: row.board.category.group.ownerId,
					},
					category: {
						id: row.board.category.categoryId,
						name: row.board.category.name,
					},
					matches: Array.from(matchesById.values()).sort(compareSearchMatches),
					indexedAt: row.updatedAt,
				});
			}

			return json(c, 200, {
				data: {
					query,
					results,
					nextCursor: hasMore && resultRows.length > 0
						? encodeCursor({ boardId: resultRows[resultRows.length - 1]!.boardId })
						: null,
				},
			});
		},
	}),
];
