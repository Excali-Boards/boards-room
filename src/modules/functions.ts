import { GrantedEntry, ResourceId, ResourceTypeGeneric, RoomData } from '../types.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { PermissionHierarchy, ResourceRank } from '../other/permissions.js';
import { BoardsManager } from '../index.js';
import { BoardType } from '@prisma/client';
import config from '../core/config.js';
import z, { ZodError } from 'zod';
import _unfurl from 'unfurl.js';
import pako from 'pako';

export function parseZodError(error: ZodError) {
	const errors: string[] = [];

	const formatSchemaPath = (path: PropertyKey[]) => {
		return !path.length ? 'Schema' : `Schema.${path.join('.')}`;
	};

	const firstLetterToLowerCase = (str: string) => {
		return str.charAt(0).toLowerCase() + str.slice(1);
	};

	const makeSureItsString = (value: unknown) => {
		return typeof value === 'string' ? value : JSON.stringify(value);
	};

	const parseZodIssue = (issue: z.core.$ZodIssue) => {
		switch (issue.code) {
			case 'invalid_type': return `${formatSchemaPath(issue.path)} must be a ${issue.expected} (invalid_type)`;
			case 'too_big': return `${formatSchemaPath(issue.path)} must be at most ${issue.maximum}${issue.inclusive ? '' : ' (exclusive)'} (too_big)`;
			case 'too_small': return `${formatSchemaPath(issue.path)} must be at least ${issue.minimum}${issue.inclusive ? '' : ' (exclusive)'} (too_small)`;
			case 'invalid_format': return `${formatSchemaPath(issue.path)} must be a valid ${issue.format} (invalid_format)`;
			case 'not_multiple_of': return `${formatSchemaPath(issue.path)} must be a multiple of ${issue.divisor} (not_multiple_of)`;
			case 'unrecognized_keys': return `${formatSchemaPath(issue.path)} has unrecognized keys: ${issue.keys.map((key) => `"${key}"`).join(', ')} (unrecognized_keys)`;
			case 'invalid_union': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_union)`;
			case 'invalid_key': return `${formatSchemaPath(issue.path)} has an invalid key: ${makeSureItsString(issue.message)} (invalid_key)`;
			case 'invalid_element': return `${formatSchemaPath(issue.path)} has an invalid element: ${firstLetterToLowerCase(issue.message)} (invalid_element)`;
			case 'invalid_value': return `${formatSchemaPath(issue.path)} has an invalid value: ${firstLetterToLowerCase(issue.message)} (invalid_value)`;
			case 'custom': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (custom)`;
			default: return `Schema has an unknown error (JSON: ${JSON.stringify(issue)})`;
		}
	};

	for (const issue of error.issues) {
		const parsedIssue = parseZodIssue(issue) + '.';
		if (parsedIssue) errors.push(parsedIssue);
	}

	return errors;
}

export function compressJSON<T>(data: T) {
	const jsonStr = JSON.stringify(data);
	const compressed = pako.gzip(jsonStr);
	return Buffer.from(compressed);
}

export function decompressJSON<T>(compressed: Buffer): T {
	const decompressed = pako.ungzip(new Uint8Array(compressed), { to: 'string' });
	return JSON.parse(decompressed);
}

const cryptoOptions = {
	authTagLength: 16,
	iv: Buffer.alloc(12, 0),

	get key() {
		const key = createHash('sha256').update(config.apiToken).digest();
		Object.defineProperty(this, 'key', { value: key });
		return key;
	},
};

export const compressionUtils = {
	compress: (data: unknown): Buffer => {
		const binary = msgpackEncode(data);
		const compressed = pako.gzip(binary);
		return Buffer.from(compressed);
	},
	decompress: <T>(compressed: Buffer): T => {
		const decompressed = pako.ungzip(new Uint8Array(compressed));
		return msgpackDecode(decompressed) as T;
	},

	compressAndEncrypt: (data: unknown): Buffer => {
		const compressed = compressionUtils.compress(data);

		const cipher = createCipheriv('aes-256-gcm', cryptoOptions.key, cryptoOptions.iv);
		const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
		const authTag = cipher.getAuthTag();

		return Buffer.concat([encrypted, authTag]);
	},

	decompressAndDecrypt: <T>(input: Buffer): T => {
		const encrypted = input.subarray(0, input.length - cryptoOptions.authTagLength);
		const authTag = input.subarray(input.length - cryptoOptions.authTagLength);

		const decipher = createDecipheriv('aes-256-gcm', cryptoOptions.key, cryptoOptions.iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		return compressionUtils.decompress<T>(decrypted);
	},
};

export const securityUtils = {
	encrypt: (input: string): string => {
		const cipher = createCipheriv('aes-256-gcm', cryptoOptions.key, cryptoOptions.iv);
		const encrypted = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
		const authTag = cipher.getAuthTag();

		const result = Buffer.concat([encrypted, authTag]);
		return result.toString('hex');
	},
	decrypt: (hex: string): string => {
		const data = Buffer.from(hex, 'hex');

		const encrypted = data.subarray(0, data.length - cryptoOptions.authTagLength);
		const authTag = data.subarray(data.length - cryptoOptions.authTagLength);

		const decipher = createDecipheriv('aes-256-gcm', cryptoOptions.key, cryptoOptions.iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		return decrypted.toString('utf8');
	},

	hash: (text: string): string => {
		return createHash('sha256').update(text).digest('hex');
	},
	randomString: (length: number): string => {
		return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
	},
};

export function toLowercase<T extends string>(str: T): Lowercase<T> {
	return str.toLowerCase() as Lowercase<T>;
}

export function isDateStringRegex(value: unknown): value is string {
	const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
	return typeof value === 'string' && isoPattern.test(value);
}

export function recursiveDateConversion<T>(data: T): T {
	if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer || data instanceof Buffer) return data as unknown as T;
	if (data instanceof Date) return data as unknown as T;
	if (Array.isArray(data)) return data.map(recursiveDateConversion) as unknown as T;
	if (typeof data === 'object' && data !== null) {
		for (const key in data) {
			data[key] = recursiveDateConversion(data[key]);
		}
	}

	return isDateStringRegex(data) ? new Date(data) as unknown as T : data;
}

export function emailToUserId(email: string): string {
	const normalizedEmail = email.trim().toLowerCase();
	const hash = createHash('sha256').update(normalizedEmail).digest('hex');
	return hash.slice(0, 16);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	else if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	else if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	else return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function firstToUpperCase<T extends string>(str: T): Capitalize<T> {
	return str.charAt(0).toUpperCase() + str.slice(1) as Capitalize<T>;
}

export async function getBoardRoom<T extends BoardType>(manager: BoardsManager, boardId: string, boardType: T): Promise<RoomData<T> | null> {
	switch (boardType) {
		case 'Excalidraw': return await manager.socket.excalidrawSocket.getRoomData(boardId) as RoomData<T> | null;
		case 'Tldraw': return await manager.socket.tldrawSocket.getRoomData(boardId) as RoomData<T> | null;
		default: return null;
	}
}

export function getGroupResourceId(resource: ResourceTypeGeneric<'group'>): ResourceId<'group'> {
	return { groupId: resource.data.groupId };
}

export function getCategoryResourceId(resource: ResourceTypeGeneric<'category'>): ResourceId<'category'> | null {
	if (!resource.data.categoryId || !resource.data.groupId) return null;
	return { categoryId: resource.data.categoryId, groupId: resource.data.groupId };
}

export function getBoardResourceId(resource: ResourceTypeGeneric<'board'>): ResourceId<'board'> | null {
	if (!resource.data.boardId || !resource.data.categoryId || !resource.data.groupId) return null;
	return { boardId: resource.data.boardId, categoryId: resource.data.categoryId, groupId: resource.data.groupId };
}

export function addPermission(map: Map<string, GrantedEntry[]>, userId: string, entry: Omit<GrantedEntry, 'grantType'>) {
	if (!map.has(userId)) map.set(userId, []);
	const perms = map.get(userId) || [];

	const existing = perms.find((p) => p.type === entry.type && p.resourceId === entry.resourceId);

	if (!existing) {
		perms.push({
			...entry,
			grantType: entry.basedOnType === entry.type ? 'explicit' : 'implicit',
		});

		return;
	}

	const curr = PermissionHierarchy[existing.role] ?? 0;
	const next = PermissionHierarchy[entry.role] ?? 0;

	existing.grantType = existing.grantType === 'explicit' ? 'explicit' : entry.basedOnType === entry.type ? 'explicit' : 'implicit';

	if (next > curr) {
		existing.role = entry.role;
		existing.basedOnType = entry.basedOnType;
		existing.basedOnResourceId = entry.basedOnResourceId;
	} else if (next === curr) {
		if (ResourceRank[entry.basedOnType] > ResourceRank[existing.basedOnType]) {
			existing.basedOnType = entry.basedOnType;
			existing.basedOnResourceId = entry.basedOnResourceId;
		}
	}
}

export async function unfurl(url: string) {
	const { title, description, open_graph, twitter_card, favicon } = await _unfurl.unfurl(url);

	const image = open_graph?.images?.[0]?.url || twitter_card?.images?.[0]?.url;

	return {
		title,
		description,
		image,
		favicon,
	};
}
