/**
 * Optional HTTP health endpoint.
 *
 * Exists so `docker compose` / Kubernetes can tell the difference between
 * "sleeping between polls" and "wedged". Returns 503 only when the most recent
 * check failed, so a single transient error does not restart the container.
 */

import { createServer } from 'node:http';

export function startHealthServer({ port, runtime, logger }) {
  if (!port) return { close: async () => {} };

  const server = createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/health' && req.url !== '/healthz') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const healthy = runtime.lastRun?.status !== 'error';
    const body = {
      status: healthy ? 'ok' : 'error',
      startedAt: runtime.startedAt,
      uptimeSeconds: Math.round((Date.now() - Date.parse(runtime.startedAt)) / 1000),
      running: runtime.running,
      nextRunAt: runtime.nextRunAt,
      lastRun: runtime.lastRun,
      lastError: runtime.lastError,
      seenAlerts: runtime.seenAlerts,
    };

    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  });

  server.on('error', (error) => logger.error('health server error', { error: error.message, port }));
  server.listen(port, '0.0.0.0', () => logger.info('health endpoint listening', { port, path: '/health' }));

  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
