import assert from 'node:assert/strict';
import test from 'node:test';

import { startHealthServer } from '../src/health.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger({ level: 'silent' });

test('health endpoint reports ok while the worker is running', async () => {
  const { createServer } = await import('node:http');
  const runtime = {
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    running: false,
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    lastRun: { at: new Date().toISOString(), status: 'ok', alertsInWindow: 2 },
    lastError: null,
    seenAlerts: 2,
  };

  // Use a real port: pick a free one via a throwaway listener.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const server = startHealthServer({ port, runtime, logger });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.seenAlerts, 2);
    assert.equal(body.lastRun.status, 'ok');
    assert.ok(body.uptimeSeconds >= 5);

    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await server.close();
  }
});

test('health endpoint reports 503 when the last check failed', async () => {
  const { createServer } = await import('node:http');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runtime = {
    startedAt: new Date().toISOString(),
    running: false,
    nextRunAt: null,
    lastRun: { at: new Date().toISOString(), status: 'error', error: 'Login timed out' },
    lastError: { at: new Date().toISOString(), message: 'Login timed out' },
    seenAlerts: 0,
  };

  const server = startHealthServer({ port, runtime, logger });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, 'error');
    assert.equal(body.lastError.message, 'Login timed out');
  } finally {
    await server.close();
  }
});

test('a port of 0 disables the health endpoint entirely', async () => {
  const server = startHealthServer({ port: 0, runtime: {}, logger });
  await server.close();
});
