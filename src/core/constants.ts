export const performanceConstants = {
	prismaCacheTtlSeconds: 60 * 60 * 24, // 24 hours

	socketSaveIntervalMs: 15 * 1000,
	socketConnectionTimeoutMs: 1000,
	socketMaxBufferSize: 50 * 1024 * 1024, // 50 MB
} as const;

export const securityConstants = {
	maxRequestSizeBytes: 10 * 1024 * 1024,

	securityHeaders: {
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'X-XSS-Protection': '1; mode=block',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Content-Security-Policy': "default-src 'self'",
		'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	},

	allowedFileTypes: [
		'image/jpeg',
		'image/png',
		'image/gif',
		'image/webp',
		'image/svg+xml',
		'application/pdf',
	] as const,

	maxFilenameLength: 255,
	forbiddenFileExtensions: [
		'.exe', '.bat', '.cmd', '.com', '.scr', '.pif',
		'.js', '.jar', '.py', '.sh', '.ps1', '.vbs',
	] as const,
} as const;

export const monitoringConstants = {
	metricsCollectionIntervalMs: 60 * 1000, // 1 minute
	systemStatusUpdateIntervalMs: 5 * 60 * 1000, // 5 minutes
} as const;
