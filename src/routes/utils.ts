import { json, makeRoute } from '../services/routes.js';
import { unfurl } from '../modules/functions.js';

export default [
	makeRoute({
		path: '/utils/unfurl',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const url = c.req.query('url');
			if (!url) return json(c, 400, { error: 'Missing url parameter.' });

			try {
				const unfurled = await unfurl(url);
				return json(c, 200, { data: unfurled });
			} catch {
				return json(c, 500, { error: 'Failed to unfurl the URL.' });
			}
		},
	}),
];
