import { parseZodError } from '../modules/functions';
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
});

const validatedConfig = ConfigSchema.safeParse(config);
if (!validatedConfig.success) throw new Error(JSON.stringify(parseZodError(validatedConfig.error), null, 5));

export default validatedConfig.data;

export type AllowedPlatforms = typeof allowedPlatforms[number];
export const allowedPlatforms = ['google', 'github', 'microsoft', 'discord'] as const;

// Zod.
export const nameObject = z.object({
	name: z.string().min(1, { message: 'Name must be at least 1 character long.' }).max(100, { message: 'Name must be at most 100 characters long.' }),
});
