import { DeleteObjectCommand, DeleteObjectCommandOutput, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectsV2Output, PutObjectCommand, PutObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { BinaryFileData } from '@excalidraw/excalidraw/dist/types/excalidraw/types';
import { BoardsManager } from '../index';
import config from '../modules/config';
import { WebResponse } from '../types';
import { Readable } from 'node:stream';
import { db } from '../modules/prisma';

export default class Files {
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

	public async hasFile(key: string): Promise<boolean> {
		try {
			const res = await this.s3.send(new HeadObjectCommand({
				Bucket: config.s3.bucket,
				Key: key,
			})).catch(() => null);

			if (!res) return false;
			return true;
		} catch {
			return false;
		}
	}

	public async getFile(key: string) {
		try {
			return this.s3.send(new GetObjectCommand({
				Bucket: config.s3.bucket,
				Key: key,
			})).catch(() => null);
		} catch {
			return null;
		}
	}

	public async getAllFiles(withPrefix?: string, continuationToken?: string): Promise<ListObjectsV2Output | null> {
		try {
			const res = await this.s3.send(new ListObjectsV2Command({
				Bucket: config.s3.bucket,
				Prefix: withPrefix,
				ContinuationToken: continuationToken,
			})).catch(() => null);

			return res;
		} catch {
			return null;
		}
	}

	public async uploadFile(key: string, file: PutObjectCommand['input']['Body'], contentType: string): Promise<PutObjectCommandOutput | null> {
		try {
			return this.s3.send(new PutObjectCommand({
				Bucket: config.s3.bucket,
				ContentType: contentType,
				Body: file,
				Key: key,
			})).catch(() => null);
		} catch {
			return null;
		}
	}

	public async deleteFile(key: string): Promise<DeleteObjectCommandOutput | null> {
		try {
			return this.s3.send(new DeleteObjectCommand({
				Bucket: config.s3.bucket,
				Key: key,
			})).catch(() => null);
		} catch {
			return null;
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
			})).catch(() => null);

			return true;
		} catch {
			return false;
		}
	}

	// Board files.
	public async createFiles(files: BinaryFileData[], boardId: string): Promise<{ success: number; failed: number; }> {
		await this.manager.prisma.client.$transaction(files.map((file) => this.manager.prisma.client.file.upsert({
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

		return {
			success: results.length - failedUploads.length,
			failed: failedUploads.length,
		};
	}

	public async deleteFiles(files: string[], boardId: string): Promise<void> {
		await db(this.manager, 'file', 'deleteMany', { where: { fileId: { in: files } } });
		await Promise.all(files.map((file) => this.deleteFile(`${boardId}/${file}`)));
	}

	public async deleteUnusedFiles(boardId?: string): Promise<WebResponse<string>> {
		const files = await db(this.manager, 'file', 'findMany', { where: boardId ? { boardId } : {} });
		if (!files) return { status: 500, error: 'Failed to get files.' };

		const s3Files = await this.getAllFiles(boardId);
		if (!s3Files) return { status: 500, error: 'Failed to get files.' };

		const toDelete = s3Files.Contents?.filter((file) => !files.some((f) => f.fileId === file.Key?.split('/')[1])) || [];
		if (!toDelete.length) return { status: 200, data: 'No files to delete.' };

		await Promise.all(toDelete.map((file) => file.Key ? this.deleteFile(file.Key) : null));
		return { status: 200, data: `Deleted ${toDelete.length} file${toDelete.length > 1 ? 's' : ''}.` };
	}
}
