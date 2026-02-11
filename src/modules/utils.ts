import { BoardWithFiles, IpApiResponse } from '../types.js';
import { BoardsManager } from '../index.js';
import config from '../core/config.js';
import { db } from '../core/prisma.js';
import axios from 'axios';
import net from 'net';

export function buildDatabaseUrl(): string {
	const url = new URL(config.databaseUrl);
	url.searchParams.set('connection_limit', config.database.poolMax.toString());
	url.searchParams.set('pool_timeout', '20');
	url.searchParams.set('connect_timeout', '10');
	return url.toString();
}

export default class Utils {

	constructor (readonly manager: BoardsManager) { }

	public async init(): Promise<void> {
		setInterval(() => void this.performCleanup().catch(() => null), 1000 * 60 * 30);
	}

	private async performCleanup(): Promise<void> {
		const now = new Date();

		await db(this.manager, 'session', 'deleteMany', { where: { expiresAt: { lte: now } } }).catch(() => null);
		await db(this.manager, 'invite', 'deleteMany', { where: { expiresAt: { lte: now } } }).catch(() => null);

		await this.manager.files.deleteUnusedFiles().catch(() => null);

		const DBBoards = await db(this.manager, 'board', 'findMany', {
			where: { scheduledForDeletion: { lte: now } },
			include: { files: true },
		}) || [];

		if (DBBoards?.length) {
			for (const board of DBBoards) {
				await this.deleteBoard(board).catch(() => null);
			}
		}
	}
	public async deleteBoard(board: BoardWithFiles): Promise<boolean> {
		try {
			const DBInvites = await db(this.manager, 'invite', 'findMany', {
				where: { boardIds: { has: board.boardId } },
			}) || [];

			await this.manager.files.deleteBoardFile(board.boardId).catch(() => null);
			await this.manager.files.deleteMediaFiles(board.boardId, board.files.map((file) => file.fileId)).catch(() => null);

			const boardDeleted = await db(this.manager, 'board', 'delete', { where: { boardId: board.boardId } }).catch(() => null);
			if (!boardDeleted) return false;

			for (const invite of DBInvites) {
				if (invite.boardIds.length === 1 && !invite.categoryIds.length && !invite.groupIds.length) {
					const inviteDeleted = await db(this.manager, 'invite', 'delete', { where: { dbId: invite.dbId } }).catch(() => null);
					if (!inviteDeleted) return false;
				} else {
					const updatedBoardIds = invite.boardIds.filter((id) => id !== board.boardId);
					const inviteUpdated = await db(this.manager, 'invite', 'update', { where: { dbId: invite.dbId }, data: { boardIds: updatedBoardIds } }).catch(() => null);
					if (!inviteUpdated) return false;
				}
			}

			return true;
		} catch {
			return false;
		}
	}

	public async getIpLocation(ip: string): Promise<string | null> {
		if (this.isPrivateIp(ip)) return null;

		try {
			const url = `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city`;
			const res = await axios.get<IpApiResponse>(url, { timeout: 5000 }).catch(() => null);
			if (!res || res.status !== 200) return null;

			const data = res.data;
			if (data.status !== 'success') return null;

			const location = [data.city, data.regionName, data.country]
				.filter(Boolean)
				.join(', ');

			return location || null;
		} catch {
			return null;
		}
	}

	private isPrivateIp(ip: string): boolean {
		if (net.isIP(ip) === 0) return true;

		if (ip.startsWith('10.')) return true; // Class A.
		if (ip.startsWith('192.168.')) return true; // Class C.

		if (ip.startsWith('172.')) {
			const secondOctet = ip.split('.')[1];
			if (!secondOctet) return false;

			const secondOctetNum = parseInt(secondOctet, 10);
			if (secondOctetNum >= 16 && secondOctetNum <= 31) return true; // Class B.
		}

		if (ip === '::1') return true; // Loopback.
		if (ip.toLowerCase().startsWith('fc00:')) return true; // Unique local.
		if (ip.toLowerCase().startsWith('fe80:')) return true; // Link-local.

		return false;
	}
}
