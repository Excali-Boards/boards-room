import { BoardsManager } from '../index';
import { db } from '../modules/prisma';

export default class Utils {
	private timer: NodeJS.Timeout | null = null;

	constructor(readonly manager: BoardsManager) {}

	public async init(): Promise<void> {
		if (this.timer) return;

		this.timer = setInterval(async () => {
			this.manager.files.triggerCacheInvalidation();

			const DBBoards = await db(this.manager, 'board', 'findMany', { where: { scheduledForDeletion: { lte: new Date() } }, include: { files: true } });
			if (!DBBoards?.length) return;

			const boardIds = DBBoards.map((board) => board.boardId);
			for (const board of DBBoards) {
				this.manager.files.deleteFile(`boards/${board.boardId}.bin`);
				this.manager.files.deleteFiles(board.files.map((file) => file.fileId), board.boardId);
			}

			await db(this.manager, 'board', 'deleteMany', { where: { boardId: { in: boardIds } } });
		}, 1000 * 60 * 30); // 30 minutes
	}
}
