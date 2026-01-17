import { HonoEnv, RouteType, StatusWebCode, WebResponse } from '../types.js';
import { securityUtils, toLowercase } from '../modules/functions.js';
import { securityConstants } from '../core/constants.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { DBUserSelectArgs } from '../other/vars.js';
import { Context, MiddlewareHandler } from 'hono';
import LoggerModule from '../modules/logger.js';
import { BoardsManager } from '../index.js';
import { readdirSync, statSync } from 'fs';
import { compress } from 'hono/compress';
import config from '../core/config.js';
import { routePath } from 'hono/route';
import { db } from '../core/prisma.js';
import { fileURLToPath } from 'url';
import { cors } from 'hono/cors';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Routes {
	private ipHits: Map<string, { count: number; lastRequest: number; }> = new Map();
	public routes: Map<`${string}|${string}`, { enabled: boolean; }> = new Map();
	public routesPath = path.join(__dirname, '..', 'routes');

	constructor (readonly manager: BoardsManager) { }

	public async init(): Promise<void> {
		await this.loadHandlers();
		await this.loadRoutes();
	}

	private async loadHandlers(): Promise<void> {
		this.manager.hono.use('*', this.manager.prometheus.metricsMiddleware());

		this.manager.hono.use(compress());
		this.manager.hono.use(cors({
			origin: (origin) => {
				if (config.allowedOrigins.includes('*')) return '*';
				if (config.allowedOrigins.includes(origin)) return origin;
				return '';
			},
			maxAge: 86400,
			credentials: true,
			allowHeaders: ['Content-Type', 'Authorization'],
			exposeHeaders: ['Content-Type', 'Authorization'],
		}));

		this.manager.hono.use('*', this.securityHeaders());
		this.manager.hono.use('*', this.requestSizeLimit());

		this.manager.hono.all('/', async (c) => {
			return json(c, 200, { data: 'Private Boards Collaboration API.' });
		});

		this.manager.hono.notFound(async (c) => {
			return json(c, 404, { error: 'Route not found (#2).' });
		});

		this.manager.hono.onError(async (err, c) => {
			this.manager.prometheus.recordError('route_handler_error', 'routes');

			LoggerModule('API', `Error ${err.name} in route [${c.req.method}] ${routePath(c)}.`, 'red');
			LoggerModule('Error', err.stack || err.message, 'red');

			return json(c, 500, { error: 'Internal server error.' });
		});
	}

	private globalHandler(): MiddlewareHandler<HonoEnv> {
		return async (c, next) => {
			const route = this.routes.get((routePath(c) + '|' + c.req.method) as `${string}|${string}`);

			if (!route) return json(c, 404, { error: 'Route not found (#3).' });
			else if (!route.enabled) return json(c, 404, { error: 'Route disabled.' });

			return next();
		};
	}

	private processRoute(route: RouteType): void {
		if (!route.path || !route.method) return;

		const handlers: MiddlewareHandler[] = [
			this.globalHandler(),
			this.rateLimit(),
		];

		const key = route.path + '|' + route.method as `${string}|${string}`;
		this.routes.set(key, { enabled: route.enabled ?? true });

		if (route.customAuth) handlers.push(this.customAuth(route.customAuth));
		if (route.auth) handlers.push(this.authenticate(route));
		handlers.push(route.handler, async (c) => {
			return json(c, 500, { error: 'Route handler forgot to send a response.' });
		});

		const methodType = toLowercase(route.method);
		if (Array.isArray(route.path)) {
			for (const p of route.path) {
				this.manager.hono[methodType](p, ...handlers);
			}
		} else {
			this.manager.hono[methodType](route.path, ...handlers);
		}
	}

	public async loadRoutes(dir: string = this.routesPath): Promise<void> {
		const files = readdirSync(dir);

		for (const file of files) {
			const filePath = path.join(dir, file);
			const stat = statSync(filePath);

			if (stat.isDirectory()) this.loadRoutes(filePath);
			else if (file.endsWith('.js')) {
				import(`file://${filePath}`).then((m) => {
					if (!m.default) return LoggerModule('API', `Route file ${file} has no default export.`, 'red');

					if (Array.isArray(m.default)) {
						for (const route of m.default) {
							this.processRoute(route);
						}
					} else {
						this.processRoute(m.default);
					}

					return;
				}).catch((err) => {
					this.manager.prometheus.recordError('route_load_error', 'routes');
					LoggerModule('API', `Error loading route file ${file}: ${err.message}`, 'red');
					LoggerModule('Error', err.stack || err.message, 'red');
				});
			}
		}
	}

	private customAuth(token: string): MiddlewareHandler<HonoEnv> {
		return async (ctx, next) => {
			const auth = ctx.req.header('Authorization');
			if (!auth) return json(ctx, 401, { error: 'Unauthorized.' });
			else if (auth !== token) return json(ctx, 401, { error: 'Invalid authorization token.' });

			return next();
		};
	}

	private authenticate(route: RouteType): MiddlewareHandler<HonoEnv> {
		return async (c, next) => {
			if (!route.auth) return next();

			const authHeader = c.req.header('Authorization');
			if (!authHeader) return json(c, 401, { error: 'Missing Authorization header.' });

			const session = await db(this.manager, 'session', 'findUnique', {
				where: { token: authHeader },
				include: { user: { ...DBUserSelectArgs } },
			});

			if (!session || session.expiresAt < new Date()) {
				if (session) await db(this.manager, 'session', 'delete', { where: { token: authHeader } });
				return json(c, 401, { error: 'Unauthorized.' });
			}

			const updateData: { lastUsed?: Date; expiresAt?: Date; } = {};
			if (session.lastUsed.getTime() < Date.now() - 15 * 60 * 1000) { // 15 minutes
				updateData.lastUsed = new Date();
			}

			// If the session is set to expire in less than 24 hours.
			if (session.expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000) {
				updateData.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
			}

			if (Object.keys(updateData).length > 0) {
				db(this.manager, 'session', 'update', { where: { token: authHeader }, data: updateData }).catch(() => null);
			}

			const isDev = config.developers.includes(securityUtils.decrypt(session.user.email));
			if (route.devOnly && !isDev) return json(c, 401, { error: 'You do not have permission to access this route.' });

			c.set('token', session.token);
			c.set('DBUser', session.user);
			c.set('isDev', isDev);

			return next();
		};
	}

	private rateLimit(options = { windowMs: 60000, max: 200 }): MiddlewareHandler<HonoEnv> { // 200 requests per minute
		return async (c, next) => {
			const info = getConnInfo(c);
			const ip = info.remote.address || 'unknown';
			const now = Date.now();

			const record = this.ipHits.get(ip) || { count: 0, lastRequest: now };

			if (now - record.lastRequest > options.windowMs) {
				record.count = 1;
				record.lastRequest = now;
			} else {
				record.count++;
			}

			this.ipHits.set(ip, record);

			if (record.count > options.max) {
				return json(c, 429, {
					error: 'Too many requests. Please try again later.',
				});
			}

			return next();
		};
	}

	private securityHeaders(): MiddlewareHandler<HonoEnv> {
		return async (c, next) => {
			Object.entries(securityConstants.securityHeaders).forEach(([key, value]) => {
				c.header(key, value);
			});

			await next();
		};
	}

	private requestSizeLimit(maxSize: number = securityConstants.maxRequestSizeBytes): MiddlewareHandler<HonoEnv> {
		return async (c, next) => {
			const contentLength = c.req.header('content-length');

			if (contentLength && parseInt(contentLength) > maxSize) {
				LoggerModule('Security', `Request size limit exceeded: ${contentLength} bytes (max: ${maxSize})`, 'yellow');
				return json(c, 413, { error: 'Request entity too large.' });
			}

			await next();
			return;
		};
	}
}

// Utility functions.
export function text<S extends StatusWebCode>(c: Context, status: S, data: string) {
	return c.text(data, status);
}

export function json<T, S extends StatusWebCode>(c: Context, status: S, data: Omit<WebResponse<T, S>, 'status'>) {
	return c.json({ status, ...data }, status);
}

export function makeRoute<
	Path extends `/${string}` = `/${string}`,
	Auth extends boolean = false,
>(route: RouteType<Path, Auth>) {
	return route;
}
