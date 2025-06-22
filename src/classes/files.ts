import { DeleteObjectCommand, DeleteObjectCommandOutput, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, HeadObjectCommandOutput, ListObjectsV2Command, ListObjectsV2Output, PutObjectCommand, PutObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { BinaryFileData } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { BoardsManager } from '../index';
import config from '../modules/config';
import { WebResponse } from '../types';
import { Readable } from 'node:stream';
import { db } from '../modules/prisma';

export default class Files {
	private boardSizeCache = new Map<string, { size: number; expiresAt: number }>();
	private readonly boardSizeCacheTTL = 5 * 60 * 1000; // 5 minutes

	private s3 = new S3Client({
		endpoint: config.s3.endpoint,
		forcePathStyle: true,
		region: 'auto',
		credentials: {
			accessKeyId: config.s3.accessKey,
			secretAccessKey: config.s3.secretKey,
		},
	});

	constructor (readonly manager: BoardsManager) { }

	public dataURLToBuffer(dataURL: string): Buffer {
		const base64Data = dataURL.split(',')[1];
		if (!base64Data) throw new Error('Invalid data URL.');
		return Buffer.from(base64Data, 'base64');
	}

	private getCachedBoardSize(boardId: string): number | null {
		const cached = this.boardSizeCache.get(boardId);
		if (cached && cached.expiresAt > Date.now()) return cached.size;
		this.boardSizeCache.delete(boardId);
		return null;
	}

	private setCachedBoardSize(boardId: string, size: number): void {
		this.boardSizeCache.set(boardId, {
			size,
			expiresAt: Date.now() + this.boardSizeCacheTTL,
		});
	}

	public triggerCacheInvalidation(): void {
		const now = Date.now();
		for (const [boardId, cache] of this.boardSizeCache.entries()) {
			if (cache.expiresAt <= now) {
				this.boardSizeCache.delete(boardId);
			}
		}
	}

	public async readableToDataURL(readable: Readable, contentType: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];

			readable.on('data', (chunk) => chunks.push(chunk));
			readable.on('end', () => {
				const buffer = Buffer.concat(chunks);
				const base64 = buffer.toString('base64');
				resolve(`data:${contentType};base64,${base64}`);
			});

			readable.on('error', reject);
		});
	}

	public async readableToBuffer(readable: Readable): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
			readable.on('end', () => resolve(Buffer.concat(chunks)));
			readable.on('error', reject);
		});
	}

	public async headFile(key: string): Promise<HeadObjectCommandOutput | null> {
		return this.s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key })).catch(() => null);
	}

	public async hasFile(key: string): Promise<boolean> {
		const head = await this.headFile(key);
		return head !== null && head.ContentLength !== undefined && head.ContentLength > 0;
	}

	public async getFile(key: string) {
		return this.s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key })).catch(() => null);
	}

	public async getAllFiles(withPrefix?: string, continuationToken?: string): Promise<ListObjectsV2Output | null> {
		return this.s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: withPrefix, ContinuationToken: continuationToken })).catch(() => null);
	}

	public async uploadFile(key: string, file: PutObjectCommand['input']['Body'], contentType: string): Promise<PutObjectCommandOutput | null> {
		return this.s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: file, ContentType: contentType })).catch((err) => {
			console.error(`Failed to upload file ${key}:`, err);
			return null;
		});
	}

	public async deleteFile(key: string): Promise<DeleteObjectCommandOutput | null> {
		return this.s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key })).catch((err) => {
			console.error(`Failed to delete file ${key}:`, err);
			return null;
		});
	}

	public async getDirectorySize(prefix: string): Promise<number> {
		try {
			let totalSize = 0;
			let ContinuationToken: string | undefined = undefined;

			do {
				const res = await this.getAllFiles(prefix, ContinuationToken);
				if (!res) return 0;

				if (res.Contents) {
					for (const obj of res.Contents) {
						if (obj.Size) totalSize += obj.Size;
					}
				}

				ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
			} while (ContinuationToken);

			return totalSize;
		} catch {
			return 0;
		}
	}

	public async deleteDirectory(prefix: string): Promise<boolean> {
		try {
			let ContinuationToken: string | undefined = undefined;

			do {
				const listResult = await this.getAllFiles(prefix, ContinuationToken);
				if (!listResult) return false;

				const objects = listResult.Contents?.map((obj) => ({ Key: obj.Key! })) || [];

				if (objects.length > 0) {
					await this.s3.send(new DeleteObjectsCommand({
						Bucket: config.s3.bucket,
						Delete: { Objects: objects },
					}));
				}

				ContinuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
			} while (ContinuationToken);

			await this.s3.send(new DeleteObjectCommand({
				Bucket: config.s3.bucket,
				Key: prefix,
			}));

			return true;
		} catch {
			return false;
		}
	}

	// Board files.
	public async createFiles(files: BinaryFileData[], boardId: string): Promise<{ success: number; failed: number; }> {
		if (!files.length) return { success: 0, failed: 0 };
		this.boardSizeCache.delete(boardId);

		const existenceChecks = await Promise.all(files.map((file) => this.hasFile(`${boardId}/${file.id}`)));
		const filesToUpload = files.filter((_, idx) => !existenceChecks[idx]);

		const results = await Promise.all(
			filesToUpload.map(async (file) => {
				try {
					return await this.uploadFile(
						`${boardId}/${file.id}`,
						this.dataURLToBuffer(file.dataURL),
						file.mimeType,
					);
				} catch {
					return null;
				}
			}),
		);

		const failedUploads = results.filter((result) => result === null);
		const nonFailedUploads = filesToUpload.filter((_, idx) => results[idx] !== null);

		await this.manager.prisma.client.$transaction(nonFailedUploads.map((file) => this.manager.prisma.client.file.upsert({
			where: { fileId: file.id },
			update: {
				mimeType: file.mimeType,
				createdAt: new Date(file.created),
			},
			create: {
				boardId,
				fileId: file.id,
				mimeType: file.mimeType,
				createdAt: new Date(file.created),
			},
		})));

		return {
			success: results.length - failedUploads.length,
			failed: failedUploads.length,
		};
	}

	public async deleteFiles(files: string[], boardId: string): Promise<void> {
		if (!files.length) return;
		this.boardSizeCache.delete(boardId);

		await db(this.manager, 'file', 'deleteMany', { where: { fileId: { in: files } } });
		await Promise.all(files.map((file) => this.deleteFile(`${boardId}/${file}`)));
	}

	public async deleteUnusedFiles(boardId?: string): Promise<WebResponse<string>> {
		if (boardId) this.boardSizeCache.delete(boardId);

		const files = await db(this.manager, 'file', 'findMany', { where: boardId ? { boardId } : {} });
		if (!files) return { status: 500, error: 'Failed to get files.' };

		const s3Files = await this.getAllFiles(boardId ? `${boardId}/` : undefined);
		if (!s3Files) return { status: 500, error: 'Failed to get files.' };

		const toDelete = s3Files.Contents
			?.filter((file) => !files.some((f) => file.Key && f.fileId === file.Key.split('/')[1]))
			.filter((file) => file.Key && !file.Key.endsWith('.bin')) || [];

		if (!toDelete.length) return { status: 200, data: 'No files to delete.' };

		const result = await Promise.all(toDelete.map((file) => file.Key ? this.deleteFile(file.Key) : null));
		const failedDeletes = result.filter((res) => res === null);

		if (failedDeletes.length) return { status: 500, error: `Failed to delete ${failedDeletes.length} file${failedDeletes.length > 1 ? 's' : ''} of ${toDelete.length}.` };
		return { status: 200, data: `Deleted ${toDelete.length} file${toDelete.length > 1 ? 's' : ''}.` };
	}

	public async getBoardSize(boardId: string): Promise<number> {
		const cached = this.getCachedBoardSize(boardId);
		if (cached !== null) return cached;

		const boardFileHead = await this.headFile(`boards/${boardId}.bin`);
		const boardFileSize = boardFileHead?.ContentLength || 0;
		const directorySize = await this.getDirectorySize(`${boardId}/`);

		const totalSize = boardFileSize + directorySize;
		this.setCachedBoardSize(boardId, totalSize);

		return totalSize;
	}
}
