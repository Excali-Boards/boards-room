import { json, makeRoute, text } from '../services/routes';
import manager from '../index';

export default [
	makeRoute({
		path: '/metrics',
		method: 'GET',
		enabled: true,

		handler: async (c) => {
			const metrics = await manager.prometheus.getMetrics().catch(() => null);
			if (!metrics) return json(c, 500, { error: 'Failed to fetch metrics.' });

			return text(c, 200, metrics);
		},
	}),

	makeRoute({
		path: '/status',
		method: 'GET',
		enabled: true,

		handler: async (c) => {
			if (!manager.prometheus.systemStatusData) return json(c, 503, { error: 'System status not available yet.' });
			return json(c, 200, { data: manager.prometheus.systemStatusData });
		},
	}),
];
