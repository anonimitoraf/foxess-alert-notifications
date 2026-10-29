/**
 * End-to-end tests for API mode: real client + mapping + de-duplication against
 * a fake FoxESS server (no network, no browser).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectAlerts } from '../src/api/collect.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { formatInZone } from '../src/time.js';
import { alarm, startApiServer } from './fixtures/apiServer.js';

const silent = createLogger({ level: 'silent' });
const TZ = 'Australia/Melbourne';

function stamp(hoursAgo) {
  return `${formatInZone(new Date(Date.now() - hoursAgo * 3600_000), TZ)} AEST`;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function configFor(url, extra = {}) {
  return loadConfig({
    FOXESS_USERNAME: 'owner@example.com',
    FOXESS_PASSWORD: 'secret',
    FOXESS_BASE_URL: url,
    FOXESS_SIGNATURE: 'off',
    DRY_RUN: 'true',
    RUN_ONCE: 'true',
    STATE_FILE: '/tmp/foxess-collect/state.json',
    LOG_LEVEL: 'error',
    ...extra,
  });
}

async function withServer(options, fn) {
  const server = await startApiServer(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('active alarms are collected even when older than the lookback window', async () => {
  const stale = alarm({ code: '1', msg: 'No Utility', date: stamp(24 * 10), recoveryDate: undefined });
  await withServer({ activeAlarms: { 'plant-1': [stale] }, historyAlarms: { 'plant-1': [] } }, async (server) => {
    const config = configFor(server.url, { FOXESS_ALERT_SCOPE: 'both', ALERT_LOOKBACK_HOURS: '24' });
    const result = await collectAlerts(config, silent);

    assert.equal(result.alerts.length, 1, 'a fault that is still active must not be aged out');
    assert.equal(result.alerts[0].title, 'No Utility');
    assert.equal(result.alerts[0].scope, 'active');
    assert.equal(result.diagnostics.alertsFromActive, 1);
    assert.equal(result.diagnostics.ignoredByLookback, 0);
  });
});

test('active and history rows for the same fault collapse into one alert', async () => {
  const shared = alarm({ date: stamp(2) });
  await withServer({ activeAlarms: { 'plant-1': [shared] }, historyAlarms: { 'plant-1': [shared] } }, async (server) => {
    const result = await collectAlerts(configFor(server.url), silent);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].source, 'api');
    assert.equal(result.diagnostics.alertsFromActive, 1);
    assert.equal(result.diagnostics.alertsFromHistory, 1);
    assert.equal(result.diagnostics.alertsInWindow, 1);
  });
});

test('history older than the lookback window is ignored', async () => {
  const history = [
    alarm({ code: '26', msg: 'Grid Voltage Fault', date: stamp(1) }),
    alarm({ code: '27', msg: 'Grid Frequency Fault', date: stamp(24 * 5) }),
  ];
  // ignoreDateFilter keeps the fake server from pre-filtering, so the lookback
  // window inside collectAlerts is what gets exercised.
  await withServer({ historyAlarms: { 'plant-1': history }, ignoreDateFilter: true }, async (server) => {
    const config = configFor(server.url, { FOXESS_ALERT_SCOPE: 'history', ALERT_LOOKBACK_HOURS: '24' });
    const result = await collectAlerts(config, silent);

    assert.deepEqual(
      result.alerts.map((alert) => alert.title),
      ['Grid Voltage Fault'],
    );
    assert.equal(result.diagnostics.ignoredByLookback, 1);
  });
});

test('scope=active skips history entirely, scope=history skips the active call', async () => {
  const active = [alarm({ date: stamp(1) })];
  const history = [alarm({ date: stamp(1) })];

  await withServer({ activeAlarms: { 'plant-1': active }, historyAlarms: { 'plant-1': history } }, async (server) => {
    const activeOnly = await collectAlerts(configFor(server.url, { FOXESS_ALERT_SCOPE: 'active' }), silent);
    assert.equal(activeOnly.alerts.length, 1);
    assert.equal(server.state.historyCalls, 0);
  });

  await withServer({ activeAlarms: { 'plant-1': active }, historyAlarms: { 'plant-1': history } }, async (server) => {
    const historyOnly = await collectAlerts(configFor(server.url, { FOXESS_ALERT_SCOPE: 'history' }), silent);
    assert.equal(historyOnly.alerts.length, 1);
    assert.ok(!server.state.requests.some((request) => request.path === '/dew/w/v0/plant/alarm'));
  });
});

test('severity filtering is applied by the caller pipeline, not silently here', async () => {
  const history = [
    alarm({ code: '1', msg: 'No Utility', date: stamp(1) }),
    alarm({ code: '26', msg: 'Grid Voltage Fault', date: stamp(2) }),
  ];
  await withServer({ historyAlarms: { 'plant-1': history } }, async (server) => {
    const result = await collectAlerts(configFor(server.url, { FOXESS_ALERT_SCOPE: 'history' }), silent);
    assert.deepEqual(
      result.alerts.map((alert) => alert.severity).sort(),
      ['critical', 'unknown'],
    );
  });
});

test('FOXESS_PLANT_IDS limits which plants are queried', async () => {
  const plants = [
    { plantID: 'plant-1', plantName: 'Home Roof', timezone: TZ },
    { plantID: 'plant-2', plantName: 'Barn', timezone: TZ },
  ];
  await withServer({ plants }, async (server) => {
    const result = await collectAlerts(configFor(server.url, { FOXESS_PLANT_IDS: 'plant-2' }), silent);
    assert.equal(result.diagnostics.plantsChecked, 1);
    const alarmCalls = server.state.requests.filter((request) => request.path === '/dew/w/v0/plant/alarm');
    assert.deepEqual(
      alarmCalls.map((request) => request.body.plantID),
      ['plant-2'],
    );
    assert.ok(result.sources.every((source) => source.label.includes('Barn')));
  });
});

test('a plant filter that matches nothing checks nothing and warns', async () => {
  await withServer({}, async (server) => {
    const result = await collectAlerts(configFor(server.url, { FOXESS_PLANT_IDS: 'nope' }), silent);
    assert.equal(result.diagnostics.plantsChecked, 0);
    assert.equal(result.alerts.length, 0);
  });
});

test('a failing plant makes the whole check fail instead of reporting "all clear"', async () => {
  await withServer(
    { failPaths: { '/dew/w/v0/plant/alarm': { errno: 50000, msg: 'Internal error' } } },
    async (server) => {
      await assert.rejects(
        () => collectAlerts(configFor(server.url, { FOXESS_ALERT_SCOPE: 'active' }), silent),
        (error) => {
          assert.equal(error.errno, 50000);
          assert.match(error.message, /Home Roof/);
          assert.match(error.message, /Internal error/);
          return true;
        },
      );
    },
  );
});

test('diagnostics describe what was checked', async () => {
  await withServer({ historyAlarms: { 'plant-1': [alarm({ date: stamp(1) })] } }, async (server) => {
    const result = await collectAlerts(configFor(server.url), silent);
    assert.equal(result.diagnostics.mode, 'api');
    assert.equal(result.diagnostics.plantsChecked, 1);
    assert.equal(result.diagnostics.signer, 'off');
    assert.ok(result.sources.length >= 2, 'both active and history views are reported');
    assert.ok(result.diagnostics.durationMs >= 0);
  });
});

test('the CLI performs a complete api-mode check and remembers what it sent', async () => {
  const history = [alarm({ date: stamp(1) })];
  await withServer({ historyAlarms: { 'plant-1': history } }, async (server) => {
    const dir = await mkdtemp(join(tmpdir(), 'foxess-cli-'));
    try {
      const env = {
        FOXESS_MODE: 'api',
        FOXESS_USERNAME: 'owner@example.com',
        FOXESS_PASSWORD: 'secret',
        FOXESS_BASE_URL: server.url,
        FOXESS_SIGNATURE: 'off',
        FOXESS_ALERT_SCOPE: 'history',
        DRY_RUN: 'true',
        MAIL_TRANSPORT: 'json',
        MAIL_TO: 'me@example.com',
        STATE_FILE: join(dir, 'state.json'),
        SESSION_FILE: join(dir, 'session.json'),
        HEALTH_PORT: '0',
        LOG_LEVEL: 'info',
      };

      // A dry run shows the email but leaves no trace at all.
      const dry = await runCli(['--once', '--dry-run'], env);
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /mode=api/);
      assert.match(dry.stdout, /Grid Voltage Fault/);
      assert.match(dry.stdout, /dry-run: email not sent/);
      assert.match(dry.stdout, /state not persisted/);
      await assert.rejects(() => readFile(join(dir, 'state.json'), 'utf8'), /ENOENT/);

      // ...so a second dry run still sees the same backlog.
      const dryAgain = await runCli(['--once', '--dry-run'], env);
      assert.match(dryAgain.stdout, /Grid Voltage Fault/);
      assert.ok(!dryAgain.stdout.includes('no new alerts to notify'));

      // A real run persists the alerts and sends through the json transport.
      const realEnv = { ...env, DRY_RUN: 'false', MAIL_JSON_DIR: join(dir, 'outbox') };
      const real = await runCli(['--once'], realEnv);
      assert.equal(real.code, 0, real.stderr);
      assert.match(real.stdout, /alert email sent/);

      const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(state.seen).length, 1);
      assert.equal(state.lastRun.status, 'ok');

      const files = await readdir(join(dir, 'outbox'));
      assert.equal(files.filter((file) => file.endsWith('.json')).length, 1);

      // The next real run knows about it and stays quiet.
      const after = await runCli(['--once'], realEnv);
      assert.match(after.stdout, /no new alerts to notify/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('wrong credentials fail immediately instead of burning the retry budget', async () => {
  await withServer({}, async (server) => {
    const dir = await mkdtemp(join(tmpdir(), 'foxess-badauth-'));
    try {
      const result = await runCli(['--once', '--dry-run'], {
        FOXESS_MODE: 'api',
        FOXESS_USERNAME: 'owner@example.com',
        FOXESS_PASSWORD: 'wrong',
        FOXESS_BASE_URL: server.url,
        FOXESS_SIGNATURE: 'off',
        DRY_RUN: 'true',
        MAIL_TO: 'me@example.com',
        MAX_ATTEMPTS: '3',
        RETRY_BACKOFF_MS: '10000',
        STATE_FILE: join(dir, 'state.json'),
        SESSION_FILE: join(dir, 'session.json'),
        HEALTH_PORT: '0',
        LOG_LEVEL: 'info',
      });

      // warnings/errors go to stderr, so look at both streams
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1);
      assert.match(output, /attempt=1 attempts=3/);
      assert.ok(!output.includes('attempt=2'), 'a credential error must not be retried');
      assert.match(output, /401|41807/);
      assert.equal(server.state.loginCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('--test-email writes a message through the configured transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foxess-test-email-'));
  try {
    const result = await runCli(['--test-email'], {
      FOXESS_MODE: 'api',
      MAIL_TRANSPORT: 'json',
      MAIL_JSON_DIR: join(dir, 'outbox'),
      MAIL_TO: 'me@example.com',
      MAIL_FROM: 'alerts@example.com',
      STATE_FILE: join(dir, 'state.json'),
      HEALTH_PORT: '0',
      LOG_LEVEL: 'info',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /test email sent/);

    const files = await readdir(join(dir, 'outbox'));
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
    const message = JSON.parse(await readFile(join(dir, 'outbox', files.find((f) => f.endsWith('.json'))), 'utf8'));
    assert.deepEqual(message.to, ['me@example.com']);
    assert.match(message.subject, /test email/);

    // It must not create run state.
    await assert.rejects(() => readFile(join(dir, 'state.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the plant timezone is read from plant/detail when plant/list omits it', async () => {
  // This is what the real API does: no `timezone` on the list row.
  const plants = [{ plantID: 'plant-1', plantName: 'Home Roof' }];
  const history = [alarm({ date: '2026-07-08 13:30:37 AEST' })];

  await withServer(
    {
      plants,
      plantDetails: { 'plant-1': { plantId: 'plant-1', plantName: 'Home Roof', timezone: 'Australia/Melbourne' } },
      historyAlarms: { 'plant-1': history },
      ignoreDateFilter: true,
    },
    async (server) => {
      const result = await collectAlerts(
        configFor(server.url, { FOXESS_ALERT_SCOPE: 'history', ALERT_LOOKBACK_HOURS: '0' }),
        silent,
      );

      assert.equal(result.alerts.length, 1);
      // 13:30:37 AEST (+10) — not 13:30:37 UTC.
      assert.equal(result.alerts[0].occurredAt, '2026-07-08T03:30:37.000Z');
      const detailCall = server.state.requests.find((request) => request.path === '/dew/w/v0/plant/detail');
      assert.ok(detailCall, 'the detail endpoint should have been queried for the zone');
      assert.equal(detailCall.method, 'GET');
    },
  );
});

test('FOXESS_TIMEZONE is used when the plant does not report one', async () => {
  const plants = [{ plantID: 'plant-1', plantName: 'Home Roof' }];
  await withServer(
    {
      plants,
      plantDetails: { 'plant-1': { plantId: 'plant-1', plantName: 'Home Roof' } },
      historyAlarms: { 'plant-1': [alarm({ date: '2026-07-08 13:30:37 AEST' })] },
      ignoreDateFilter: true,
    },
    async (server) => {
      const result = await collectAlerts(
        configFor(server.url, {
          FOXESS_ALERT_SCOPE: 'history',
          ALERT_LOOKBACK_HOURS: '0',
          FOXESS_TIMEZONE: 'Australia/Melbourne',
        }),
        silent,
      );
      assert.equal(result.alerts[0].occurredAt, '2026-07-08T03:30:37.000Z');
    },
  );
});
