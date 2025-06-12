import { HonoEnv, RouteType, StatusWebCode, StatusWebResponse } from '../types';
import { securityUtils, toLowercase } from '../modules/utils';
import { Context, MiddlewareHandler } from 'hono';
import LoggerModule from '../modules/logger';
import { readdirSync, statSync } from 'fs';
import { compress } from 'hono/compress';
import { BoardsManager } from '../index';
import config from '../modules/config';
import { db } from '../modules/prisma';
import { cors } from 'hono/cors';
import path from 'path';

export default class Routes {
	public routes: Map<`${string}|${string}`, { enabled: boolean; }> = new Map();
	public routePath = path.join(__dirname, '..', 'routes');

	constructor(readonly manager: BoardsManager) {}

	public async init(): Promise<void> {
		await this.loadHandlers();
		await this.loadRoutes();
	}

	private async loadHandlers(): Promise<void> {
		this.manager.hono.use(compress());
		this.manager.hono.use('*', cors({
			origin: config.isDev ? '*' : config.allowedOrigins,
			allowHeaders: ['Content-Type', 'Authorization'],
			allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
			credentials: true,
		}));

		this.manager.hono.all('/', async (c) => {
			return json(c, 200, { data: 'Private Boards Collaboration API.' });
		});

		this.manager.hono.notFound(async (c) => {
			return json(c, 404, { error: 'Route not found (#2).' });
		});

		this.manager.hono.onError(async (err, c) => {
			LoggerModule('API', `Error ${err.name} in route [${c.req.method}] ${c.req.routePath}.`, 'red');
			console.error(err);

			return json(c, 500, { error: 'Internal server error.' });
		});
	}

	private globalHandler(): MiddlewareHandler<HonoEnv> {
		return async (c, next) => {
			const route = this.routes.get((c.req.routePath + '|' + c.req.method) as `${string}|${string}`);

			if (!route) return json(c, 404, { error: 'Route not found (#3).' });
			else if (!route.enabled) return json(c, 404, { error: 'Route disabled.' });

			return next();
		};
	}

	private processRoute(route: RouteType): void {
		if (!route.path || !route.method) return;

		const handlers: MiddlewareHandler[] = [
			this.globalHandler(),
		];

		const key = route.path + '|' + route.method as `${string}|${string}`;
		this.routes.set(key, { enabled: route.enabled ?? true });

		if (route.customAuth) handlers.push(this.customAuth(route.customAuth));
		if (route.auth) handlers.push(this.authenticate(route));
		handlers.push(route.handler, async (c) => {
			return json(c, 500, { error: 'Route handler forgot to send a response.' });
		});

		const methodType = toLowercase(route.method);
		this.manager.hono[methodType](route.path, ...handlers);
	}

	public async loadRoutes(dir: string = this.routePath): Promise<void> {
		const files = readdirSync(dir);

		for (const file of files) {
			const filePath = path.join(dir, file);
			const stat = statSync(filePath);

			if (stat.isDirectory()) {
				this.loadRoutes(filePath);
			} else if (file.endsWith('.js')) {
				import(filePath).then((m) => {
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
					LoggerModule('API', `Error loading route file ${file}: ${err.message}`, 'red');
					console.error(err);
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

			const DBUser = await db(this.manager, 'user', 'findUnique', {
				where: { email: authHeader },
				select: {
					userId: true,
					email: true,
					avatarUrl: true,
					displayName: true,
					mainLoginType: true,
					isBoardsAdmin: true,
					mainGroupId: true,
					ownedBoards: {
						select: {
							boardId: true,
							name: true,
						},
					},
					boardPermissions: {
						select: {
							boardId: true,
							permissionType: true,
						},
					},
				},
			}).catch(() => null);
			if (!DBUser) return json(c, 401, { error: 'Unauthorized.' });

			const isDev = config.developers.includes(securityUtils.decrypt(DBUser.email));
			if (route.devOnly && !isDev) return json(c, 401, { error: 'You do not have permission to access this route.' });

			c.set('DBUser', DBUser);
			c.set('isDev', isDev);
			c.set('privileged', DBUser.isBoardsAdmin || isDev);

			return next();
		};
	}
}

// Utility functions.
export function json<T, S extends StatusWebCode>(c: Context, status: S, data: Omit<StatusWebResponse<T, S>, 'status'>) {
	return c.json({ status, ...data }, status);
}

export function makeRoute<
	Path extends `/${string}` = `/${string}`,
	Auth extends boolean = false,
>(route: RouteType<Path, Auth>) {
	return route;
}
