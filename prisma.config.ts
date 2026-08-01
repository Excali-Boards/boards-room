import { defineConfig } from 'prisma/config';
import path from 'node:path';
import 'dotenv/config';

export default defineConfig({
	schema: path.join('prisma', 'schema'),
});
