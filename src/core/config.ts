import { parseZodError } from '../modules/functions.js';
import { BoardType } from '@prisma/client';
import env from 'dotenv';
import { z } from 'zod';

env.config();

const config = {
	allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.replace(/\/$/, '')),

	apiToken: process.env.API_TOKEN!,
	databaseUrl: process.env.DATABASE_URL!,

	port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3004,
	developers: process.env.DEVELOPERS?.split(',') || [],
	isDev: process.env.NODE_ENV === 'development',

	s3: {
		endpoint: process.env.S3_ENDPOINT!,
		accessKey: process.env.S3_ACCESS_KEY!,
		secretKey: process.env.S3_SECRET_KEY!,
		bucket: process.env.S3_BUCKET!,
	},

	valkey: {
		host: process.env.CACHE_HOST || 'localhost',
		port: process.env.CACHE_PORT ? parseInt(process.env.CACHE_PORT, 10) : 6379,
		password: process.env.CACHE_PASSWORD || null,
		db: process.env.CACHE_DB ? parseInt(process.env.CACHE_DB, 10) : 0,
		ttl: process.env.CACHE_DEFAULT_TTL ? parseInt(process.env.CACHE_DEFAULT_TTL, 10) : 300,
	},

	database: {
		poolMin: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN, 10) : 2,
		poolMax: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10,
	},
} satisfies z.infer<typeof ConfigSchema>;

const ConfigSchema = z.object({
	allowedOrigins: z.array(z.string()),

	apiToken: z.string(),
	databaseUrl: z.string(),

	port: z.number().int().min(1).max(65535),
	developers: z.array(z.string()),
	isDev: z.boolean(),

	s3: z.object({
		endpoint: z.string(),
		accessKey: z.string(),
		secretKey: z.string(),
		bucket: z.string(),
	}),

	valkey: z.object({
		host: z.string(),
		port: z.number().int().min(1).max(65535),
		password: z.string().nullable(),
		db: z.number().int().min(0).max(15),
		ttl: z.number().int().min(1),
	}),

	database: z.object({
		poolMin: z.number().int().min(1).max(100),
		poolMax: z.number().int().min(1).max(100),
	}),
});

const validatedConfig = ConfigSchema.safeParse(config);
if (!validatedConfig.success) throw new Error(JSON.stringify(parseZodError(validatedConfig.error), null, 5));

export default validatedConfig.data;

export type AllowedPlatforms = typeof allowedPlatforms[number];
export const allowedPlatforms = ['google', 'github', 'microsoft', 'discord'] as const;

// Zod.
export const nameObject = z.object({
	name: z.string().min(1).max(100),
});

export const countryCodeObject = z.object({
	calCode: z.string().length(2).toUpperCase().regex(/^[A-Z]{2}$/, 'Country code must be 2 letters.').nullable(),
});

export const boardObject = nameObject.extend({
	type: z.enum(BoardType),
});
