import { parseZodError, resolveClientIp, securityUtils } from '../modules/functions.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { makeRoute, json } from '../services/routes.js';
import { trimSessions } from './sessions.js';
import { Device } from '@prisma/client';
import config from '../core/config.js';
import { db } from '../core/prisma.js';
import { randomBytes } from 'crypto';
import manager from '../index.js';
import { Context } from 'hono';
import { z } from 'zod';

type QrState = Record<string, string>;
type QrChallengeStatus = 'pending' | 'approved' | 'denied';
type LiveQrState = QrState & { status: QrChallengeStatus; expiresAt: string; userCode: string; };

const QR_CHALLENGE_TTL_SECONDS = 5 * 60;
const QR_DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const QR_MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const QR_RATE_LIMIT_WINDOW_SECONDS = 60;
const QR_CREATE_LIMIT_PER_WINDOW = 5;
const QR_CODE_REQUEST_LIMIT_PER_WINDOW = 12;
const QR_REDEEM_LIMIT_PER_WINDOW = 30;
const QR_MAX_CREATE_ATTEMPTS = 5;

const userCodeAlphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export default [
	makeRoute({
		path: '/auth/qr/challenges',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			if (!manager.cache.isAvailable()) return cacheUnavailable(c);

			const ip = getRequestIp(c);
			if (!ip) return json(c, 403, { error: 'Unable to determine client IP address.' });

			const rateLimitResponse = await checkRateLimit(c, `qr:create:${hashForKey(ip)}`, QR_CREATE_LIMIT_PER_WINDOW);
			if (rateLimitResponse) return rateLimitResponse;

			const parsed = qrCreateSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return json(c, 400, { error: parseZodError(parsed.error) });

			const expiresAt = Date.now() + QR_CHALLENGE_TTL_SECONDS * 1000;
			for (let attempt = 0; attempt < QR_MAX_CREATE_ATTEMPTS; attempt++) {
				const deviceCode = securityUtils.randomString(64);
				const deviceHash = getQrDeviceHash(deviceCode);
				const userCode = generateUserCode();

				let created: boolean;
				try {
					created = await manager.cache.createQrChallenge({
						challengeKey: deviceKey(deviceHash),
						codeKey: codeKey(userCode),
						userCode,
						expiresAt,
						requestDevice: parsed.data.requestDevice || '',
						deviceHash,
						ttlSeconds: QR_CHALLENGE_TTL_SECONDS,
					});
				} catch {
					return cacheUnavailable(c);
				}

				if (created === true) {
					c.header('Cache-Control', 'no-store');

					return json(c, 200, {
						data: {
							deviceCode,
							userCode,
							expiresAt: new Date(expiresAt),
							requestDevice: parsed.data.requestDevice || null,
						},
					});
				}
			}

			return cacheUnavailable(c);
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/lookup',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			if (!manager.cache.isAvailable()) return cacheUnavailable(c);

			const ip = getRequestIp(c);
			if (!ip) return json(c, 403, { error: 'Unable to determine client IP address.' });

			const rateLimitResponse = await checkRateLimit(c, `qr:code:${hashForKey(ip)}`, QR_CODE_REQUEST_LIMIT_PER_WINDOW);
			if (rateLimitResponse) return rateLimitResponse;

			const parsed = qrCodeSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return unavailable(c);

			let state: LiveQrState | null;
			try {
				state = await getStateByUserCode(parsed.data.userCode);
			} catch {
				return cacheUnavailable(c);
			}
			if (!state) return unavailable(c);

			c.header('Cache-Control', 'no-store');
			return json(c, 200, { data: toPublicState(state) });
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/decision',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			if (!manager.cache.isAvailable()) return cacheUnavailable(c);

			const ip = getRequestIp(c);
			if (!ip) return json(c, 403, { error: 'Unable to determine client IP address.' });
			const rateLimitResponse = await checkRateLimit(c, `qr:decision:${hashForKey(ip)}`, QR_CODE_REQUEST_LIMIT_PER_WINDOW);
			if (rateLimitResponse) return rateLimitResponse;

			const parsed = qrDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return unavailable(c);

			const now = Date.now();
			const approving = parsed.data.decision === 'approve';
			const sessionExpiresAt = approving ? now + (parsed.data.expiresInSeconds || QR_DEFAULT_SESSION_TTL_SECONDS) * 1000 : 0;
			const sessionToken = approving ? securityUtils.randomString(128) : '';

			let deviceHash: string | null;
			try {
				deviceHash = await getDeviceHashByUserCode(parsed.data.userCode);
			} catch {
				return cacheUnavailable(c);
			}
			if (!deviceHash) return unavailable(c);

			let decided: boolean;
			try {
				decided = await manager.cache.decideQrChallenge({
					codeKey: codeKey(parsed.data.userCode),
					challengeKey: deviceKey(deviceHash),
					deviceHash,
					decision: parsed.data.decision,
					userId: c.var.DBUser.userId,
					sessionToken,
					sessionExpiresAt,
					qrLoginRedirectDelay: c.var.DBUser.qrLoginRedirectDelay,
					now,
				});
			} catch {
				return cacheUnavailable(c);
			}

			if (!decided) return unavailable(c);

			c.header('Cache-Control', 'no-store');
			return json(c, 200, {
				data: parsed.data.decision === 'approve'
					? { status: 'approved' as const, expiresAt: new Date(sessionExpiresAt) }
					: { status: 'denied' as const },
			});
		},
	}),
	makeRoute({
		path: '/auth/qr/challenges/redeem',
		method: 'POST',
		enabled: true,
		customAuth: config.apiToken,

		handler: async (c) => {
			if (!manager.cache.isAvailable()) return cacheUnavailable(c);

			const ip = getRequestIp(c);
			if (!ip) return json(c, 403, { error: 'Unable to determine client IP address.' });

			const parsed = qrRedeemSchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return unavailable(c);

			const deviceHash = getQrDeviceHash(parsed.data.deviceCode);

			const rateLimitResponse = await checkRateLimit(c, `qr:redeem:device:${deviceHash}`, QR_REDEEM_LIMIT_PER_WINDOW);
			if (rateLimitResponse) return rateLimitResponse;

			const ipRateLimitResponse = await checkRateLimit(c, `qr:redeem:ip:${hashForKey(ip)}`, QR_REDEEM_LIMIT_PER_WINDOW);
			if (ipRateLimitResponse) return ipRateLimitResponse;

			let state: QrState | null;
			try {
				state = await manager.cache.getHashStrict(deviceKey(deviceHash));
			} catch {
				return cacheUnavailable(c);
			}
			if (!state || !isLiveState(state)) return qrStatus(c, 'expired');
			if (state.status === 'pending') return qrStatus(c, 'pending');
			if (state.status === 'denied') return qrStatus(c, 'denied');

			const sessionExpiresAt = new Date(Number(state.sessionExpiresAt));
			if (!state.sessionToken || !state.approvedByUserId || !Number.isFinite(sessionExpiresAt.getTime()) || sessionExpiresAt.getTime() <= Date.now()) return qrStatus(c, 'expired');

			const location = await manager.utils.getIpLocation(ip);
			const locationEncrypted = location ? securityUtils.encryptRandom(location) : null;

			try {
				await db(manager, 'session', 'create', {
					data: {
						token: state.sessionToken,
						device: parsed.data.device,
						locationEncrypted,
						isQrLogin: true,
						userId: state.approvedByUserId,
						expiresAt: sessionExpiresAt,
					},
				});
			} catch {
				const existing = await manager.prisma.session.findUnique({ where: { token: state.sessionToken } }).catch(() => null);
				if (!existing || existing.userId !== state.approvedByUserId || !existing.isQrLogin || existing.expiresAt.getTime() !== sessionExpiresAt.getTime()) return cacheUnavailable(c);
			}

			await trimSessions(state.approvedByUserId, state.sessionToken);
			c.header('Cache-Control', 'no-store');
			return json(c, 200, {
				data: {
					status: 'approved' as const,
					token: state.sessionToken,
					expiresAt: sessionExpiresAt,
					redirectDelay: state.qrLoginRedirectDelay !== 'false',
				},
			});
		},
	}),
];

// Functions.
function deviceKey(deviceHash: string) {
	return `qr:device:${deviceHash}`;
}

function codeKey(userCode: string) {
	return `qr:code:${normalizeQrUserCode(userCode)}`;
}

function hashForKey(value: string) {
	return securityUtils.hash(value).slice(0, 48);
}

function getQrDeviceHash(deviceCode: string) {
	return securityUtils.hash(deviceCode).slice(0, 48);
}

function generateUserCode() {
	const result: string[] = [];
	while (result.length < 8) {
		const byte = randomBytes(1).readUInt8(0);
		result.push(userCodeAlphabet[byte % userCodeAlphabet.length]!);
	}
	return `${result.slice(0, 4).join('')}-${result.slice(4).join('')}`;
}

function normalizeQrUserCode(value: string) {
	return value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function formatQrUserCode(value: string) {
	const normalized = normalizeQrUserCode(value);
	return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function isValidQrUserCode(value: string) {
	return /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(normalizeQrUserCode(value));
}

function getRequestIp(c: Context) {
	const connection = getConnInfo(c);
	return resolveClientIp((name) => c.req.header(name), connection.remote.address);
}

function cacheUnavailable(c: Context) {
	c.header('Cache-Control', 'no-store');
	return json(c, 503, { error: 'QR login is temporarily unavailable.' });
}

function unavailable(c: Context) {
	c.header('Cache-Control', 'no-store');
	return json(c, 404, { error: 'QR login request is unavailable.' });
}

function qrStatus(c: Context, status: 'pending' | 'denied' | 'expired') {
	c.header('Cache-Control', 'no-store');
	return json(c, 200, { data: { status } });
}

async function checkRateLimit(c: Context, key: string, maximum: number) {
	const count = await manager.cache.increment(key, QR_RATE_LIMIT_WINDOW_SECONDS);
	if (count === null) return cacheUnavailable(c);
	if (count > maximum) {
		c.header('Cache-Control', 'no-store');
		return json(c, 429, { error: 'Too many QR login requests. Please try again later.' });
	}

	return null;
}

async function getStateByUserCode(userCode: string): Promise<LiveQrState | null> {
	const deviceHash = await manager.cache.getRawStrict(codeKey(userCode));
	if (!deviceHash) return null;

	const state = await manager.cache.getHashStrict(deviceKey(deviceHash));
	return state && isLiveState(state) ? state : null;
}

async function getDeviceHashByUserCode(userCode: string) {
	return manager.cache.getRawStrict(codeKey(userCode));
}

function isLiveState(state: QrState): state is LiveQrState {
	return (state.status === 'pending' || state.status === 'approved' || state.status === 'denied')
		&& typeof state.userCode === 'string'
		&& Number(state.expiresAt) > Date.now();
}

function toPublicState(state: LiveQrState) {
	return {
		userCode: formatQrUserCode(state.userCode),
		status: state.status,
		expiresAt: new Date(Number(state.expiresAt)),
		requestDevice: state.requestDevice || null,
	};
}

// Schemas.
const qrCreateSchema = z.object({
	requestDevice: z.string().trim().min(1).max(120).optional(),
});

const qrCodeSchema = z.object({
	userCode: z.string().trim().min(8).max(12).refine(isValidQrUserCode),
});

const qrDecisionSchema = qrCodeSchema.extend({
	decision: z.enum(['approve', 'deny']),
	expiresInSeconds: z.number().int().min(15 * 60).max(QR_MAX_SESSION_TTL_SECONDS).optional(),
});

const qrRedeemSchema = z.object({
	deviceCode: z.string().regex(/^[a-f0-9]{64}$/i),
	device: z.enum(Device).default(Device.Desktop),
});
