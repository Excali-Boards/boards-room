import { DeleteObjectCommand, DeleteObjectCommandOutput, GetObjectCommand, GetObjectCommandOutput, HeadObjectCommand, HeadObjectCommandOutput, ListObjectsV2Command, ListObjectsV2Output, PutObjectCommand, PutObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { BinaryFileData } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { BoardsManager } from '../index';
import { WebResponse } from '../types';
import { Readable } from 'node:stream';
import config from '../core/config';
import { db } from '../core/prisma';

export default class Files {
	private s3 = new S3Client({
		endpoint: config.s3.endpoint,
		forcePathStyle: true,
		region: 'auto',
		credentials: {
			accessKeyId: config.s3.accessKey,
			secretAccessKey: config.s3.secretKey,
		},
		requestHandler: {
			connectionTimeout: 5000,
			socketTimeout: 10000,
		},
		maxAttempts: 3,
	});

	constructor (readonly manager: BoardsManager) { }

	public dataURLToBuffer(dataURL: string): Buffer {
		const base64Data = dataURL.split(',')[1];
		if (!base64Data) throw new Error('Invalid data URL.');
		return Buffer.from(base64Data, 'base64');
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

	private async headFile(key: string): Promise<HeadObjectCommandOutput | null> {
		try {
			return await this.s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
		} catch {
			return null;
		}
	}

	private async hasFile(key: string): Promise<boolean> {
		const head = await this.headFile(key);
		return head !== null && head.ContentLength !== undefined && head.ContentLength > 0;
	}

	private async getFile(key: string): Promise<GetObjectCommandOutput | null> {
		try {
			return await this.s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
		} catch {
			return null;
		}
	}

	public async getBoardFile(boardId: string): Promise<GetObjectCommandOutput | null> {
		return this.getFile(`boards/${boardId}.bin`);
	}

	public async getMediaFile(boardId: string, fileId: string): Promise<GetObjectCommandOutput | null> {
		return this.getFile(`${boardId}/${fileId}`);
	}

	private async getAllFiles(withPrefix?: string, continuationToken?: string): Promise<ListObjectsV2Output | null> {
		try {
			return await this.s3.send(new ListObjectsV2Command({
				Bucket: config.s3.bucket,
				Prefix: withPrefix,
				ContinuationToken: continuationToken,
				MaxKeys: 1000,
			}));
		} catch {
			return null;
		}
	}

	private async updateBoardTotalSize(boardId: string): Promise<void> {
		const boardFileHead = await this.headFile(`boards/${boardId}.bin`);
		const boardFileSize = boardFileHead?.ContentLength || 0;

		const mediaFilesSize = await db(this.manager, 'file', 'aggregate', {
			where: { boardId },
			_sum: { sizeBytes: true },
		});

		const totalSize = boardFileSize + (mediaFilesSize?._sum.sizeBytes || 0);

		await db(this.manager, 'board', 'update', {
			where: { boardId },
			data: { totalSizeBytes: totalSize },
		});
	}

	public async uploadBoardFile(boardId: string, file: PutObjectCommand['input']['Body'], contentType: string, skipBoardSizeUpdate: boolean = false): Promise<PutObjectCommandOutput | null> {
		return this.uploadFile(`boards/${boardId}.bin`, file, contentType, skipBoardSizeUpdate);
	}

	public async uploadMediaFile(boardId: string, fileId: string, file: PutObjectCommand['input']['Body'], contentType: string, skipBoardSizeUpdate: boolean = false): Promise<PutObjectCommandOutput | null> {
		return this.uploadFile(`${boardId}/${fileId}`, file, contentType, skipBoardSizeUpdate);
	}

	private async uploadFile(key: string, file: PutObjectCommand['input']['Body'], contentType: string, skipBoardSizeUpdate: boolean = false): Promise<PutObjectCommandOutput | null> {
		try {
			let fileSize = 0;
			if (Buffer.isBuffer(file)) fileSize = file.length;
			else if (typeof file === 'string') fileSize = Buffer.byteLength(file, 'utf8');

			const result = await this.s3.send(new PutObjectCommand({
				Bucket: config.s3.bucket,
				Key: key,
				Body: file,
				ContentType: contentType,
			}));

			this.manager.prometheus.recordFileOperation('upload', 'success');

			if (key.includes('/') && fileSize > 0) {
				const [prefix, fileId] = key.split('/');
				if (!prefix || !fileId) return result;

				if (prefix === 'boards' && fileId.endsWith('.bin')) {
					const boardId = fileId.replace('.bin', '');
					if (!skipBoardSizeUpdate) await this.updateBoardTotalSize(boardId);
				} else {
					const boardId = prefix;
					await db(this.manager, 'file', 'upsert', {
						where: { fileId },
						update: {
							sizeBytes: fileSize,
							mimeType: contentType,
						},
						create: {
							boardId,
							fileId,
							mimeType: contentType,
							sizeBytes: fileSize,
							createdAt: new Date(),
						},
					});

					if (!skipBoardSizeUpdate) await this.updateBoardTotalSize(boardId);
				}
			}

			return result;
		} catch (error) {
			this.manager.prometheus.recordFileOperation('upload', 'error');
			throw error;
		}
	}

	public async deleteBoardFile(boardId: string): Promise<DeleteObjectCommandOutput | null> {
		return this.deleteFile(`boards/${boardId}.bin`);
	}

	public async deleteMediaFile(boardId: string, fileId: string): Promise<DeleteObjectCommandOutput | null> {
		return this.deleteFile(`${boardId}/${fileId}`);
	}

	private async deleteFile(key: string): Promise<DeleteObjectCommandOutput | null> {
		try {
			const result = await this.s3.send(new DeleteObjectCommand({
				Bucket: config.s3.bucket,
				Key: key,
			}));

			this.manager.prometheus.recordFileOperation('delete', 'success');
			return result;
		} catch {
			this.manager.prometheus.recordFileOperation('delete', 'error');
			return null;
		}
	}

	public async getDirectorySize(prefix: string): Promise<number> {
		let totalSize = 0;
		let ContinuationToken: string | undefined = undefined;
		const baseDelay = 100;
		const maxRetries = 3;

		do {
			let retryCount = 0;
			let res: ListObjectsV2Output | null = null;

			while (retryCount <= maxRetries) {
				try {
					res = await Promise.race([
						this.s3.send(new ListObjectsV2Command({
							Bucket: config.s3.bucket,
							Prefix: prefix,
							ContinuationToken,
							MaxKeys: 1000,
						})),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error('Request timeout')), 10000),
						),
					]);
					break;
				} catch (error) {
					retryCount++;
					if (retryCount > maxRetries) {
						throw error;
					}

					const delay = baseDelay * Math.pow(2, retryCount - 1);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}

			if (!res) return 0;

			if (res.Contents) {
				totalSize += res.Contents.reduce((sum, obj) => sum + (obj.Size || 0), 0);
			}

			ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
		} while (ContinuationToken);

		return totalSize;
	}

	// Board files management.
	public async createFiles(files: BinaryFileData[], boardId: string): Promise<{ success: number; failed: number; }> {
		if (!files.length) return { success: 0, failed: 0 };

		const existenceChecks = await Promise.all(files.map((file) => this.hasFile(`${boardId}/${file.id}`)));
		const filesToUpload = files.filter((_, idx) => !existenceChecks[idx]);

		const results = await Promise.all(
			filesToUpload.map(async (file) => {
				try {
					const buffer = this.dataURLToBuffer(file.dataURL);
					return await this.uploadMediaFile(boardId, file.id, buffer, file.mimeType, true);
				} catch {
					return null;
				}
			}),
		);

		const failedUploads = results.filter((result) => result === null);
		const successfulFiles = filesToUpload.filter((_, idx) => results[idx] !== null);

		if (successfulFiles.length > 0) {
			await this.manager.prisma.$transaction(successfulFiles.map((file) => {
				const buffer = this.dataURLToBuffer(file.dataURL);
				return this.manager.prisma.file.upsert({
					where: { fileId: file.id },
					update: {
						mimeType: file.mimeType,
						sizeBytes: buffer.length,
						createdAt: new Date(file.created),
					},
					create: {
						boardId,
						fileId: file.id,
						mimeType: file.mimeType,
						sizeBytes: buffer.length,
						createdAt: new Date(file.created),
					},
				});
			})).catch(() => null);

			await this.updateBoardTotalSize(boardId);
		}

		return {
			success: results.length - failedUploads.length,
			failed: failedUploads.length,
		};
	}

	public async deleteMediaFiles(boardId: string, files: string[]): Promise<void> {
		if (!files.length) return;

		await db(this.manager, 'file', 'deleteMany', { where: { fileId: { in: files } } });
		await Promise.all(files.map((file) => this.deleteMediaFile(boardId, file)));
		await this.updateBoardTotalSize(boardId);
	}

	public async deleteUnusedFiles(boardId?: string): Promise<WebResponse<string>> {
		const files = await db(this.manager, 'file', 'findMany', { where: boardId ? { boardId } : {} });
		if (!files) return { status: 500, error: 'Failed to get files.' };

		const s3Files = await this.getAllFiles(boardId ? `${boardId}/` : undefined);
		if (!s3Files) return { status: 500, error: 'Failed to get files.' };

		const toDelete = s3Files.Contents // Filter out files that are still in the database.
			?.filter((file) => !files.some((f) => file.Key && f.fileId === file.Key.split('/')[1]))
			.filter((file) => file.Key && !file.Key.endsWith('.bin')) || [];

		if (!toDelete.length) return { status: 200, data: 'No files to delete.' };

		const result = await Promise.all(toDelete.map((file) => file.Key ? this.deleteFile(file.Key) : null));
		const failedDeletes = result.filter((res) => res === null);

		if (failedDeletes.length) return { status: 500, error: `Failed to delete ${failedDeletes.length} file${failedDeletes.length > 1 ? 's' : ''} of ${toDelete.length}.` };
		return { status: 200, data: `Deleted ${toDelete.length} file${toDelete.length > 1 ? 's' : ''}.` };
	}
}
