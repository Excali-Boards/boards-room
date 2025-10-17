import { getBoardRoom, parseZodError } from '../modules/functions.js';
import { hasAccessToBoard } from '../other/permissions.js';
import { json, makeRoute } from '../services/routes.js';
import { UploadFile } from '../types.js';
import config from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/files/:boardId/base64',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');

			const isValid = base64FileSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const access = await hasAccessToBoard(manager, c.var.DBUser, boardId);
			if (!access.hasAccess || !access.canEdit) return json(c, 403, { error: 'You do not have permission to upload files to this board.' });

			const binaryFiles = isValid.data.map((file) => {
				const data = file.data.startsWith('data:') ? file.data : `data:${file.mimeType};base64,${file.data}`;

				return {
					id: file.id, data,
					mimeType: file.mimeType,
				};
			});

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId }, select: { type: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const result = await manager.socket.handleFileAction(boardId, DBBoard.type, { action: 'add', files: binaryFiles });
			if (typeof result === 'string') return json(c, 400, { error: result });
			if (!result) return json(c, 500, { error: 'Failed to upload files.' });

			return json(c, 200, { data: result });
		},
	}),

	makeRoute({
		path: '/files/:boardId/raw',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');
			const formData = await c.req.formData().catch(() => null);
			if (!formData) return json(c, 400, { error: 'Invalid form data.' });

			const access = await hasAccessToBoard(manager, c.var.DBUser, boardId);
			if (!access.hasAccess || !access.canEdit) return json(c, 403, { error: 'You do not have permission to upload files to this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const files: UploadFile[] = [];
			const clientFileMapping: { file: File; clientId: string; }[] = [];

			for (const [key, value] of formData.entries()) {
				if (key.startsWith('file-') && value instanceof File) {
					const clientId = key.replace('file-', '');

					files.push({
						id: clientId,
						data: value,
						mimeType: value.type || 'application/octet-stream',
					});

					clientFileMapping.push({ file: value, clientId });
				}
			}

			if (files.length === 0) return json(c, 400, { error: 'No files provided.' });

			const result = await manager.socket.handleFileAction(boardId, DBBoard.type, { action: 'add', files });
			if (typeof result === 'string') return json(c, 400, { error: result });
			if (!result) return json(c, 500, { error: 'Failed to upload files.' });

			const urlMappings = clientFileMapping.map(({ clientId }, index) => {
				const fileData = files[index];
				if (!fileData) throw new Error('File mapping error');

				return {
					clientId,
					serverId: fileData.id,
					url: `${config.s3.endpoint}/${config.s3.bucket}/${boardId}/${fileData.id}`,
				};
			});

			return json(c, 200, {
				data: {
					...result,
					files: urlMappings,
				},
			});
		},
	}),

	makeRoute({
		path: '/files/:boardId/delete',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const boardId = c.req.param('boardId');

			const isValid = fileDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const access = await hasAccessToBoard(manager, c.var.DBUser, boardId);
			if (!access.hasAccess || !access.canEdit) return json(c, 403, { error: 'You do not have permission to delete files from this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found' });

			const roomData = await getBoardRoom(manager, boardId, DBBoard.type);
			if (!roomData) return json(c, 500, { error: 'Failed to get board room data.' });

			const result = await manager.socket.handleFileAction(boardId, DBBoard.type, { action: 'remove', files: isValid.data });
			if (typeof result === 'string') return json(c, 400, { error: result });

			return json(c, 200, { data: 'Files deleted successfully.' });
		},
	}),
];

const base64FileSchema = z.array(z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
})).min(1, 'At least one file is required.');

const fileDeleteSchema = z.array(z.string()).min(1, 'At least one file ID is required.');

export type Base64FileInput = z.infer<typeof base64FileSchema>;
export type FileDeleteInput = z.infer<typeof fileDeleteSchema>;

export type FileUrlMapping = {
	clientId: string;
	serverId: string;
	url: string;
};

export type RawFileUploadResponse = {
	success: number;
	failed: number;
	files: FileUrlMapping[];
};
