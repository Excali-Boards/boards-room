import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { ZodError, ZodIssue } from 'zod';
import config from './config';
import pako from 'pako';

export function parseZodError(error: ZodError) {
	const errors: string[] = [];

	const formatSchemaPath = (path: (string | number)[]) => {
		return !path.length ? 'Schema' : `Schema.${path.join('.')}`;
	};

	const firstLetterToLowerCase = (str: string) => {
		return str.charAt(0).toLowerCase() + str.slice(1);
	};

	const makeSureItsString = (value: unknown) => {
		return typeof value === 'string' ? value : JSON.stringify(value);
	};

	const parseZodIssue = (issue: ZodIssue) => {
		switch (issue.code) {
			case 'invalid_type': return `${formatSchemaPath(issue.path)} must be a ${issue.expected} (invalid_type)`;
			case 'invalid_literal': return `${formatSchemaPath(issue.path)} must be a ${makeSureItsString(issue.expected)} (invalid_literal)`;
			case 'custom': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (custom)`;
			case 'invalid_union': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_union)`;
			case 'invalid_union_discriminator': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_union_discriminator)`;
			case 'invalid_enum_value': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_enum_value)`;
			case 'unrecognized_keys': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (unrecognized_keys)`;
			case 'invalid_arguments': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_arguments)`;
			case 'invalid_return_type': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_return_type)`;
			case 'invalid_date': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_date)`;
			case 'invalid_string': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_string)`;
			case 'too_small': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (too_small)`;
			case 'too_big': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (too_big)`;
			case 'invalid_intersection_types': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (invalid_intersection_types)`;
			case 'not_multiple_of': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (not_multiple_of)`;
			case 'not_finite': return `${formatSchemaPath(issue.path)} ${firstLetterToLowerCase(issue.message)} (not_finite)`;
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
	ivLength: 12,
	keyLength: 16,
	saltLength: 12,
	authTagLength: 16,
	pbkdf2Iterations: 50000,

	key: createHash('sha256').update(config.apiToken).digest(),
	iv: Buffer.alloc(12, 0),
};

export const compressionUtils = {
	compress: (data: unknown): Buffer =>{
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
