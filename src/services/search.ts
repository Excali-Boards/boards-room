import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { BoardType } from '@prisma/client';
import type { RoomSnapshot } from '@tldraw/sync';
import config from '../core/config.js';
import { compressionUtils } from '../modules/functions.js';
import LoggerModule from '../modules/logger.js';
import type { BoardsManager } from '../index.js';
import { Readable } from 'node:stream';

const SEARCH_INDEX_BATCH_SIZE = 10;
const MAX_CHUNK_ITEMS = 512;
const MAX_CHUNK_TEXT_CHARACTERS = 128_000;
const MAX_SEARCHABLE_TEXT_LENGTH = 64_000;
const MAX_STORED_TEXT_LENGTH = 4_096;
const MAX_TOKENS_PER_ITEM = 2_048;
const MAX_TOKEN_PREFIX_LENGTH = 32;
const MAX_BUCKET_COUNT = 32_768;

export type BoardSearchMatch = {
	elementId: string;
	kind: string;
	text: string;
	truncated: boolean;
	x?: number;
	y?: number;
	pageId?: string;
};

export type StoredSearchItem = BoardSearchMatch & {
	tokenHashes: number[];
};

export type SearchElementChange = {
	elementId: string;
	item: StoredSearchItem | null;
};

export type SearchIndexJob = {
	boardId: string;
	boardName: string;
	boardType: BoardType;
	version: number;
	data: ExcalidrawElement[] | RoomSnapshot;
};

export type SearchIndexDeltaJob = SearchIndexJob & {
	previousVersion: number;
	changes: SearchElementChange[];
};

type PendingSearchJob = {
	mode: 'full' | 'delta';
	full: SearchIndexJob;
	previousVersion?: number;
	changes?: SearchElementChange[];
};

type SearchChunk = {
	chunkId: number;
	items: StoredSearchItem[];
	tokenHashes: number[];
};

type SearchDocument = {
	bucketCount: number;
	nameTokenHashes: number[];
	chunks: SearchChunk[];
};

type BackfillBoard = {
	boardId: string;
	name: string;
	type: BoardType;
	version: number;
	searchIndex: { indexedVersion: number; boardName: string; } | null;
};

type TldrawRecord = {
	typeName?: unknown;
	type?: unknown;
	id?: unknown;
	x?: unknown;
	y?: unknown;
	parentId?: unknown;
	props?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isTextElement = (element: ExcalidrawElement | null): element is ExcalidrawTextElement => element?.type === 'text';

const normalizeText = (value: string): string => value.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim();

const truncate = (value: string, maxLength: number): string => value.length > maxLength ? value.slice(0, maxLength) : value;

const readNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

const hashString = (value: string): number => {
	let hash = 2_166_136_261;

	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}

	return hash | 0;
};

const getBucketId = (elementId: string, bucketCount: number): number => (hashString(elementId) >>> 0) % bucketCount;

const getTokenPrefixes = (value: string): string[] => {
	const tokens = new Set<string>();
	const words = value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];

	for (const word of words) {
		if (word.length < 2) continue;

		const maxPrefixLength = Math.min(word.length, MAX_TOKEN_PREFIX_LENGTH);
		for (let length = 2; length <= maxPrefixLength; length++) {
			tokens.add(word.slice(0, length));
			if (tokens.size >= MAX_TOKENS_PER_ITEM) return Array.from(tokens);
		}
	}

	return Array.from(tokens);
};

export const makeSearchTokenHashes = (value: string): number[] => Array.from(new Set(getTokenPrefixes(value).map(hashString)));

const extractRichText = (value: unknown, output: string[] = []): string[] => {
	if (typeof value === 'string') {
		output.push(value);
		return output;
	}

	if (Array.isArray(value)) {
		for (const child of value) extractRichText(child, output);
		return output;
	}

	if (!isRecord(value)) return output;

	if (typeof value.text === 'string') output.push(value.text);
	if (value.type === 'paragraph' || value.type === 'heading' || value.type === 'listItem' || value.type === 'hardBreak') output.push('\n');
	if ('content' in value) extractRichText(value.content, output);
	if ('children' in value) extractRichText(value.children, output);

	return output;
};

const makeSearchItem = (elementId: string, kind: string, text: string, position?: { x?: number; y?: number; pageId?: string }): StoredSearchItem | null => {
	const normalized = normalizeText(text);
	if (!normalized) return null;

	const searchableText = truncate(normalized, MAX_SEARCHABLE_TEXT_LENGTH);
	const tokenHashes = makeSearchTokenHashes(searchableText);
	if (tokenHashes.length === 0) return null;

	return {
		elementId,
		kind,
		text: truncate(normalized, MAX_STORED_TEXT_LENGTH),
		truncated: normalized.length > MAX_STORED_TEXT_LENGTH,
		tokenHashes,
		...(position?.x === undefined ? {} : { x: position.x }),
		...(position?.y === undefined ? {} : { y: position.y }),
		...(position?.pageId ? { pageId: position.pageId } : {}),
	};
};

const getExcalidrawSearchItem = (element: ExcalidrawElement): StoredSearchItem | null => {
	if (element.isDeleted || element.customData?.hideFromViewOnly) return null;

	if (isTextElement(element)) {
		return makeSearchItem(element.id, 'excalidraw-text', element.originalText, { x: element.x, y: element.y });
	}

	return null;
};

const getTldrawSearchItem = (document: RoomSnapshot['documents'][number]): StoredSearchItem | null => {
	const record = isRecord(document.state) ? document.state as TldrawRecord : null;
	if (!record || record.typeName !== 'shape' || typeof record.id !== 'string') return null;

	const props = isRecord(record.props) ? record.props : {};
	const richText = extractRichText(props.richText).join(' ');
	const text = richText || readString(props.text);
	if (!text) return null;

	return makeSearchItem(
		record.id,
		'tldraw-' + (typeof record.type === 'string' ? record.type : 'shape'),
		text,
		{
			x: readNumber(record.x),
			y: readNumber(record.y),
			pageId: typeof record.parentId === 'string' ? record.parentId : undefined,
		},
	);
};

const areSearchItemsEqual = (first: StoredSearchItem | null, second: StoredSearchItem | null): boolean => JSON.stringify(first) === JSON.stringify(second);

export const getExcalidrawSearchChanges = (
	previous: readonly ExcalidrawElement[],
	current: readonly ExcalidrawElement[],
): SearchElementChange[] => {
	const previousById = new Map(previous.map((element) => [element.id, element]));
	const currentById = new Map(current.map((element) => [element.id, element]));
	const elementIds = new Set([...previousById.keys(), ...currentById.keys()]);
	const changes: SearchElementChange[] = [];

	for (const elementId of elementIds) {
		const previousItem = previousById.get(elementId) ? getExcalidrawSearchItem(previousById.get(elementId)!) : null;
		const currentItem = currentById.get(elementId) ? getExcalidrawSearchItem(currentById.get(elementId)!) : null;
		if (!areSearchItemsEqual(previousItem, currentItem)) changes.push({ elementId, item: currentItem });
	}

	return changes;
};

export const getTldrawSearchChanges = (previous: RoomSnapshot, current: RoomSnapshot): SearchElementChange[] => {
	const previousById = new Map((Array.isArray(previous.documents) ? previous.documents : []).map((document) => {
		const record = isRecord(document.state) ? document.state as TldrawRecord : null;
		return [typeof record?.id === 'string' ? record.id : '', document] as const;
	}).filter(([elementId]) => elementId));
	const currentById = new Map((Array.isArray(current.documents) ? current.documents : []).map((document) => {
		const record = isRecord(document.state) ? document.state as TldrawRecord : null;
		return [typeof record?.id === 'string' ? record.id : '', document] as const;
	}).filter(([elementId]) => elementId));
	const elementIds = new Set([...previousById.keys(), ...currentById.keys()]);
	const changes: SearchElementChange[] = [];

	for (const elementId of elementIds) {
		const previousItem = previousById.get(elementId) ? getTldrawSearchItem(previousById.get(elementId)!) : null;
		const currentItem = currentById.get(elementId) ? getTldrawSearchItem(currentById.get(elementId)!) : null;
		if (!areSearchItemsEqual(previousItem, currentItem)) changes.push({ elementId, item: currentItem });
	}

	return changes;
};

const extractExcalidrawItems = (elements: readonly ExcalidrawElement[]): StoredSearchItem[] => elements
	.map(getExcalidrawSearchItem)
	.filter((item): item is StoredSearchItem => item !== null);

const extractTldrawItems = (snapshot: RoomSnapshot): StoredSearchItem[] => snapshot.documents
	.map(getTldrawSearchItem)
	.filter((item): item is StoredSearchItem => item !== null);

const getBucketCount = (items: readonly StoredSearchItem[]): number => {
	const totalTextCharacters = items.reduce((total, item) => total + item.text.length, 0);
	let bucketCount = 1;

	while (
		(items.length / bucketCount > MAX_CHUNK_ITEMS || totalTextCharacters / bucketCount > MAX_CHUNK_TEXT_CHARACTERS)
		&& bucketCount < MAX_BUCKET_COUNT
	) {
		bucketCount *= 2;
	}

	return bucketCount;
};

const getChunkTokenHashes = (items: readonly StoredSearchItem[]): number[] => Array.from(new Set(items.flatMap((item) => item.tokenHashes)));

const buildChunks = (items: readonly StoredSearchItem[], bucketCount: number): SearchChunk[] => {
	const buckets = new Map<number, StoredSearchItem[]>();

	for (const item of items) {
		const chunkId = getBucketId(item.elementId, bucketCount);
		const bucket = buckets.get(chunkId) || [];
		bucket.push(item);
		buckets.set(chunkId, bucket);
	}

	return Array.from(buckets.entries())
		.map(([chunkId, chunkItems]) => ({
			chunkId,
			items: chunkItems,
			tokenHashes: getChunkTokenHashes(chunkItems),
		}))
		.sort((first, second) => first.chunkId - second.chunkId);
};

const buildSearchDocument = (job: SearchIndexJob): SearchDocument => {
	const items = job.boardType === 'Excalidraw'
		? extractExcalidrawItems(job.data as ExcalidrawElement[])
		: extractTldrawItems(job.data as RoomSnapshot);
	const bucketCount = getBucketCount(items);

	return {
		bucketCount,
		nameTokenHashes: makeSearchTokenHashes(job.boardName),
		chunks: buildChunks(items, bucketCount),
	};
};

const serializeChunk = (items: readonly StoredSearchItem[]): Buffer => compressionUtils.compressAndEncrypt(items);

const deserializeChunk = (payload: Uint8Array): StoredSearchItem[] => {
	try {
		const parsed = compressionUtils.decompressAndDecrypt<unknown>(Buffer.from(payload));
		return Array.isArray(parsed) ? parsed as StoredSearchItem[] : [];
	} catch {
		return [];
	}
};

const toFullJob = (job: SearchIndexJob): PendingSearchJob => ({ mode: 'full', full: job });

export class BoardSearchIndexer {
	private pending = new Map<string, PendingSearchJob>();
	private processing = false;
	private stopping = false;
	private backfillPromise: Promise<void> | null = null;

	constructor (private readonly manager: BoardsManager) { }

	public async init(): Promise<void> {
		if (!config.globalSearchEnabled) return;
		this.backfillPromise = this.backfill();
	}

	public enqueueFull(job: SearchIndexJob): void {
		if (!config.globalSearchEnabled || this.stopping) return;

		const existing = this.pending.get(job.boardId);
		if (existing && existing.full.version > job.version) return;

		this.pending.set(job.boardId, toFullJob(job));
		void this.processQueue();
	}

	public enqueueDelta(job: SearchIndexDeltaJob): void {
		if (!config.globalSearchEnabled || this.stopping) return;

		const existing = this.pending.get(job.boardId);
		if (!existing) {
			this.pending.set(job.boardId, {
				mode: 'delta',
				full: job,
				previousVersion: job.previousVersion,
				changes: job.changes,
			});
		} else if (existing.mode === 'full') {
			if (existing.full.version > job.version) return;
			existing.full = job;
		} else if (existing.full.version === job.previousVersion) {
			const changesById = new Map((existing.changes || []).map((change) => [change.elementId, change]));
			for (const change of job.changes) changesById.set(change.elementId, change);
			existing.full = job;
			existing.changes = Array.from(changesById.values());
		} else if (existing.full.version < job.previousVersion) {
			this.pending.set(job.boardId, toFullJob(job));
		} else {
			return;
		}

		void this.processQueue();
	}

	public async enqueueBoard(boardId: string): Promise<void> {
		if (!config.globalSearchEnabled || this.stopping) return;

		try {
			const board = await this.manager.prisma.board.findUnique({
				where: { boardId },
				select: { boardId: true, name: true, type: true, version: true },
			});
			if (!board) return;

			const data = await this.loadBoardData(board.boardId, board.type);
			this.enqueueFull({
				boardId: board.boardId,
				boardName: board.name,
				boardType: board.type,
				version: board.version,
				data,
			});
		} catch (error) {
			this.manager.prometheus.recordError('search_enqueue_error', 'search');
			LoggerModule('Search', 'Failed to enqueue board ' + boardId + ': ' + error, 'red');
		}
	}

	public async updateBoardName(boardId: string, boardName: string): Promise<void> {
		if (!config.globalSearchEnabled || this.stopping) return;

		try {
			await this.manager.prisma.boardSearchIndex.updateMany({
				where: { boardId },
				data: { boardName, nameTokenHashes: makeSearchTokenHashes(boardName) },
			});
		} catch (error) {
			this.manager.prometheus.recordError('search_name_update_error', 'search');
			LoggerModule('Search', 'Failed to update board name for ' + boardId + ': ' + error, 'red');
		}
	}

	public async shutdown(): Promise<void> {
		this.stopping = true;
		void this.processQueue();
		await this.drain();
		await this.backfillPromise;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;

		this.processing = true;
		try {
			while (this.pending.size > 0) {
				const next = this.pending.values().next().value as PendingSearchJob | undefined;
				if (!next) break;

				this.pending.delete(next.full.boardId);
				try {
					if (next.mode === 'delta') {
						await this.persistDelta({
							...next.full,
							previousVersion: next.previousVersion!,
							changes: next.changes || [],
						});
					} else {
						await this.persistFull(next.full);
					}
				} catch (error) {
					this.manager.prometheus.recordError('search_index_error', 'search');
					LoggerModule('Search', 'Failed to index board ' + next.full.boardId + ': ' + error, 'red');
				}
			}
		} finally {
			this.processing = false;
			if (this.pending.size > 0 && !this.stopping) void this.processQueue();
		}
	}

	private async persistFull(job: SearchIndexJob): Promise<void> {
		const board = await this.manager.prisma.board.findUnique({
			where: { boardId: job.boardId },
			select: { name: true },
		});
		if (!board) return;

		const currentJob = { ...job, boardName: board.name };
		const document = buildSearchDocument(currentJob);

		await this.manager.prisma.$transaction(async (transaction) => {
			const existing = await transaction.boardSearchIndex.findUnique({
				where: { boardId: currentJob.boardId },
				select: { indexedVersion: true },
			});
			if (existing && existing.indexedVersion > currentJob.version) return;

			const index = await transaction.boardSearchIndex.upsert({
				where: { boardId: currentJob.boardId },
				create: {
					boardId: currentJob.boardId,
					boardName: currentJob.boardName,
					indexedVersion: currentJob.version,
					bucketCount: document.bucketCount,
					nameTokenHashes: document.nameTokenHashes,
				},
				update: {
					boardName: currentJob.boardName,
					indexedVersion: currentJob.version,
					bucketCount: document.bucketCount,
					nameTokenHashes: document.nameTokenHashes,
				},
				select: { dbId: true },
			});

			await transaction.boardSearchChunk.deleteMany({ where: { boardSearchIndexId: index.dbId } });
			if (document.chunks.length === 0) return;

			await transaction.boardSearchChunk.createMany({
				data: document.chunks.map((chunk) => ({
					boardSearchIndexId: index.dbId,
					chunkId: chunk.chunkId,
					tokenHashes: chunk.tokenHashes,
					payload: serializeChunk(chunk.items),
				})),
			});
		}, { maxWait: 10_000, timeout: 120_000 });
	}

	private async persistDelta(job: SearchIndexDeltaJob): Promise<void> {
		const applied = await this.manager.prisma.$transaction(async (transaction) => {
			const index = await transaction.boardSearchIndex.findUnique({
				where: { boardId: job.boardId },
				select: { dbId: true, indexedVersion: true, bucketCount: true },
			});

			if (!index || index.indexedVersion !== job.previousVersion) return false;

			const changesByChunk = new Map<number, SearchElementChange[]>();
			for (const change of job.changes) {
				const chunkId = getBucketId(change.elementId, index.bucketCount);
				const changes = changesByChunk.get(chunkId) || [];
				changes.push(change);
				changesByChunk.set(chunkId, changes);
			}

			const chunkIds = Array.from(changesByChunk.keys());
			const existingChunks = chunkIds.length > 0
				? await transaction.boardSearchChunk.findMany({
					where: { boardSearchIndexId: index.dbId, chunkId: { in: chunkIds } },
					select: { dbId: true, chunkId: true, payload: true },
				})
				: [];
			const existingByChunk = new Map(existingChunks.map((chunk) => [chunk.chunkId, chunk]));

			for (const [chunkId, changes] of changesByChunk) {
				const existingChunk = existingByChunk.get(chunkId);
				const itemsById = new Map((existingChunk ? deserializeChunk(existingChunk.payload) : []).map((item) => [item.elementId, item]));

				for (const change of changes) {
					if (change.item) itemsById.set(change.elementId, change.item);
					else itemsById.delete(change.elementId);
				}

				const items = Array.from(itemsById.values());
				if (items.length === 0) {
					if (existingChunk) await transaction.boardSearchChunk.delete({ where: { dbId: existingChunk.dbId } });
					continue;
				}

				const data = {
					tokenHashes: getChunkTokenHashes(items),
					payload: serializeChunk(items),
				};

				if (existingChunk) {
					await transaction.boardSearchChunk.update({ where: { dbId: existingChunk.dbId }, data });
				} else {
					await transaction.boardSearchChunk.create({
						data: {
							boardSearchIndexId: index.dbId,
							chunkId,
							...data,
						},
					});
				}
			}

			await transaction.boardSearchIndex.update({
				where: { dbId: index.dbId },
				data: {
					indexedVersion: job.version,
				},
			});

			return true;
		}, { maxWait: 10_000, timeout: 120_000 });

		if (!applied) await this.persistFull(job);
	}

	private async backfill(): Promise<void> {
		try {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			let lastBoardId: string | null = null;

			while (!this.stopping) {
				const boards: BackfillBoard[] = await this.manager.prisma.board.findMany({
					where: lastBoardId ? { boardId: { gt: lastBoardId } } : undefined,
					select: {
						boardId: true,
						name: true,
						type: true,
						version: true,
						searchIndex: { select: { indexedVersion: true, boardName: true } },
					},
					orderBy: { boardId: 'asc' },
					take: SEARCH_INDEX_BATCH_SIZE,
				});

				if (boards.length === 0) return;

				for (const board of boards) {
					lastBoardId = board.boardId;
					if (
						board.searchIndex &&
						board.searchIndex.indexedVersion >= board.version &&
						board.searchIndex.boardName === board.name
					) continue;

					try {
						const data = await this.loadBoardData(board.boardId, board.type);
						this.enqueueFull({
							boardId: board.boardId,
							boardName: board.name,
							boardType: board.type,
							version: board.version,
							data,
						});
						await this.drain();
					} catch (error) {
						this.manager.prometheus.recordError('search_backfill_error', 'search');
						LoggerModule('Search', 'Failed to backfill board ' + board.boardId + ': ' + error, 'red');
					}
				}
			}
		} catch (error) {
			this.manager.prometheus.recordError('search_backfill_error', 'search');
			LoggerModule('Search', 'Board search backfill stopped: ' + error, 'red');
		}
	}

	private async loadBoardData(boardId: string, boardType: BoardType): Promise<ExcalidrawElement[] | RoomSnapshot> {
		const file = await this.manager.files.getBoardFile(boardId);
		if (!file) return boardType === 'Excalidraw' ? [] : { clock: 0, documents: [] };

		const body = await this.manager.files.readableToBuffer(file.Body as Readable);
		if (boardType === 'Excalidraw') return compressionUtils.decompressAndDecrypt<ExcalidrawElement[]>(body);

		const snapshot = compressionUtils.decompressAndDecrypt<RoomSnapshot>(body);
		return {
			...snapshot,
			clock: typeof snapshot.clock === 'number' ? snapshot.clock : 0,
			documents: Array.isArray(snapshot.documents) ? snapshot.documents : [],
		};
	}

	private async drain(): Promise<void> {
		while (this.processing || this.pending.size > 0) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}
