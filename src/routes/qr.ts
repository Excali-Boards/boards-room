import { parseZodError, securityUtils } from '../modules/functions.js';
import { makeRoute, json } from '../services/routes.js';
import { trimSessions } from './sessions.js';
import { timingSafeEqual } from 'crypto';
import { Device } from '@prisma/client';
import config from '../core/config.js';
import manager from '../index.js';
import { z } from 'zod';

const qrStatus = {
	pending: 'pending',
	approved: 'approved',
	consumed: 'consumed',
} as const;

export default [
	makeRoute({
		path: '/auth/qr/challenges',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			const now = new Date();
			await manager.prisma.qrLoginChallenge.deleteMany({
				where: {
					expiresAt: { lt: now },
					status: { in: [qrStatus.pending, qrStatus.approved] },
				},
			});

			const secret = securityUtils.randomString(64);
			const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
			const challenge = await manager.prisma.qrLoginChallenge.create({
				select: { dbId: true, expiresAt: true },
				data: {
					secretHash: securityUtils.hash(secret),
					expiresAt,
				},
			});

			return json(c, 200, {
				data: {
					challengeId: challenge.dbId,
					secret,
					expiresAt: challenge.expiresAt,
				},
			});
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/status',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			const isValid = qrChallengeSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const secretHash = securityUtils.hash(isValid.data.secret);
			const challenge = await manager.prisma.qrLoginChallenge.findUnique({ where: { dbId: isValid.data.challengeId } });
			if (!challenge || !hasValidSecret(challenge.secretHash, isValid.data.secret)) return json(c, 404, { error: 'QR login challenge not found.' });

			const now = new Date();
			if (challenge.status !== qrStatus.consumed && challenge.expiresAt <= now) {
				await manager.prisma.qrLoginChallenge.updateMany({
					where: { dbId: challenge.dbId, secretHash, status: challenge.status, expiresAt: { lte: now } },
					data: { status: qrStatus.consumed },
				});

				return json(c, 200, { data: { status: 'expired' as const } });
			}

			const status = challenge.status === qrStatus.pending
				? 'pending' as const
				: challenge.status === qrStatus.approved
					? 'approved' as const
					: 'consumed' as const;

			return json(c, 200, { data: { status, expiresAt: challenge.expiresAt } });
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/approve',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const isValid = qrApprovalSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const now = new Date();
			const sessionExpiresAt = new Date(now.getTime() + isValid.data.expiresInSeconds * 1000);
			const approved = await manager.prisma.qrLoginChallenge.updateMany({
				where: {
					dbId: isValid.data.challengeId,
					secretHash: securityUtils.hash(isValid.data.secret),
					status: qrStatus.pending,
					expiresAt: { gt: now },
				},
				data: {
					status: qrStatus.approved,
					approvedByUserId: c.var.DBUser.userId,
					approvedAt: now,
					sessionExpiresAt,
				},
			});

			if (approved.count !== 1) return json(c, 400, { error: 'This QR login request is expired or has already been handled.' });
			return json(c, 200, { data: { status: 'approved' as const, expiresAt: sessionExpiresAt } });
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/complete',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			const isValid = qrCompleteSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const secretHash = securityUtils.hash(isValid.data.secret);
			const challenge = await manager.prisma.qrLoginChallenge.findUnique({ where: { dbId: isValid.data.challengeId } });
			const now = new Date();
			if (!challenge || !hasValidSecret(challenge.secretHash, isValid.data.secret)) return json(c, 404, { error: 'QR login challenge not found.' });
			if (challenge.status !== qrStatus.approved || !challenge.approvedByUserId || !challenge.sessionExpiresAt || challenge.expiresAt <= now || challenge.sessionExpiresAt <= now) {
				return json(c, 400, { error: 'This QR login request is not approved or has expired.' });
			}

			const token = securityUtils.randomString(128);
			const location = isValid.data.ip ? await manager.utils.getIpLocation(isValid.data.ip) : null;
			const locationEncrypted = location ? securityUtils.encryptRandom(location) : null;
			const completed = await manager.prisma.$transaction(async (tx) => {
				const consumed = await tx.qrLoginChallenge.updateMany({
					where: {
						dbId: challenge.dbId,
						secretHash,
						status: qrStatus.approved,
						expiresAt: { gt: now },
						sessionExpiresAt: { gt: now },
					},
					data: { status: qrStatus.consumed, consumedAt: now },
				});

				if (consumed.count !== 1) return false;

				await tx.session.create({
					data: {
						token,
						device: isValid.data.device,
						locationEncrypted,
						isQrLogin: true,
						userId: challenge.approvedByUserId!,
						expiresAt: challenge.sessionExpiresAt!,
					},
				});

				return true;
			});

			if (!completed) return json(c, 400, { error: 'This QR login request has already been completed.' });

			await trimSessions(challenge.approvedByUserId, token);

			return json(c, 200, {
				data: { token, expiresAt: challenge.sessionExpiresAt },
			});
		},
	}),
];

// Functions.
function hasValidSecret(secretHash: string, secret: string) {
	const expected = Buffer.from(secretHash, 'hex');
	const received = Buffer.from(securityUtils.hash(secret), 'hex');
	return expected.length === received.length && timingSafeEqual(expected, received);
}

// Schemas.
const qrChallengeSchema = z.object({
	challengeId: z.string().min(1).max(100),
	secret: z.string().length(64),
});

const qrApprovalSchema = qrChallengeSchema.extend({
	expiresInSeconds: z.number().int().min(15 * 60).max(7 * 24 * 60 * 60).default(24 * 60 * 60),
});

const qrCompleteSchema = qrChallengeSchema.extend({
	device: z.enum(Device).default(Device.Desktop),
	ip: z.string().optional(),
});
