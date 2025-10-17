import { Client } from 'pg';
import env from 'dotenv';

env.config();

const connectionURL = process.env.DATABASE_URL;
if (!connectionURL) throw new Error('Missing DATABASE_URL environment variable.');

const defaultSchemaUrl = connectionURL.replace(/\/[^/]*$/, '/postgres');
const dbName = connectionURL?.replace(/.*\//, '');

const forceDrop = process.argv.includes('--force');

const clientMain = new Client({ connectionString: defaultSchemaUrl });

(async () => {
	try {
		await clientMain.connect();

		const result = await clientMain.query(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);

		if (result.rows.length !== 0) {
			if (forceDrop) {
				const clientDb = new Client({ connectionString: connectionURL });
				await clientDb.connect();

				console.log(`--force provided. Dropping and recreating the "public" schema in database "${dbName}"...`);

				await clientDb.query('DROP SCHEMA IF EXISTS public CASCADE');
				console.log('Dropped the "public" schema.');

				await clientDb.query('CREATE SCHEMA public');
				console.log('Recreated the "public" schema.');

				await clientDb.query('GRANT ALL ON SCHEMA public TO public');
				console.log('Re-granted default privileges on the "public" schema.');

				await clientDb.end();
			} else {
				console.log('Database already exists.');
			}

			return;
		}

		await clientMain.query(`CREATE DATABASE "${dbName}"`);
		console.log('Database created.');
	} catch (error) {
		console.error('Error:', error);
	} finally {
		await clientMain.end();
	}
})();
