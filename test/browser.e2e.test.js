/**
 * End-to-end tests.
 *
 * They run the real scraper against a local fixture that mimics the parts of
 * FoxESS Cloud the scraper depends on (hash routing, login form, signed-looking
 * JSON endpoint, rendered alarm table). Skipped automatically when Playwright's
 * Chromium is not installed, so `npm test` still works in a bare CI image.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { scrapeAlerts } from '../src/scraper/scrape.js';
import { startFixtureServer } from './fixtures/server.js';

const silentLogger = createLogger({ level: 'silent' });

async function chromiumAvailable() {
  try {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const browserReady = await chromiumAvailable();
const skip = browserReady ? false : 'playwright chromium is not installed (run: npx playwright install chromium)';

function testEnv(baseUrl, dir, extra = {}) {
  return {
    FOXESS_USERNAME: 'owner@example.com',
    FOXESS_PASSWORD: 'super-secret',
    FOXESS_BASE_URL: baseUrl,
    FOXESS_MODE: 'browser',
    HEADLESS: 'true',
    NAV_TIMEOUT_MS: '15000',
    LOGIN_TIMEOUT_MS: '15000',
    PAGE_SETTLE_MS: '250',
    POLL_JITTER_SECONDS: '0',
    STATE_FILE: join(dir, 'state.json'),
    SESSION_FILE: join(dir, 'session.json'),
    MAIL_TRANSPORT: 'json',
    MAIL_JSON_DIR: join(dir, 'outbox'),
    MAIL_TO: 'me@example.com',
    HEALTH_PORT: '0',
    LOG_LEVEL: 'error',
    ...extra,
  };
}

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'foxess-e2e-'));
  const fixture = await startFixtureServer();
  try {
    return await fn({ dir, fixture });
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('scraper logs in, captures alerts from the API and the DOM table', { skip }, async () => {
  await withFixture(async ({ dir, fixture }) => {
    const config = loadConfig(testEnv(fixture.url, dir));
    const result = await scrapeAlerts(config, silentLogger);

    assert.equal(fixture.state.loginAttempts, 1, 'exactly one login');
    assert.equal(
      result.diagnostics.reusedSession,
      false,
      'first run cannot reuse a session that does not exist yet',
    );

    // 3 alarms exist, 1 is older than the 24h lookback window.
    assert.equal(result.diagnostics.alertsFromNetwork, 3);
    assert.equal(result.diagnostics.alertsFromDom, 3);
    assert.equal(result.diagnostics.ignoredByLookback, 1);

    // Network + DOM describe the same alarms, so de-duplication must collapse them.
    assert.equal(result.alerts.length, 2);
    const titles = result.alerts.map((alert) => alert.title).sort();
    assert.deepEqual(titles, ['Battery Low Temperature', 'Grid Loss']);

    const gridLoss = result.alerts.find((alert) => alert.title === 'Grid Loss');
    assert.equal(gridLoss.severity, 'critical');
    assert.equal(gridLoss.device, 'SN-0001');
    assert.equal(gridLoss.site, 'Home Roof');
    assert.equal(gridLoss.source, 'network', 'structured data must win over the table row');

    const battery = result.alerts.find((alert) => alert.title === 'Battery Low Temperature');
    assert.equal(battery.severity, 'warning');

    assert.ok(result.sources.some((source) => source.url.includes('/bus/alarm')));
  });
});

test('a second run reuses the saved browser session instead of logging in again', { skip }, async () => {
  await withFixture(async ({ dir, fixture }) => {
    const config = loadConfig(testEnv(fixture.url, dir));
    await scrapeAlerts(config, silentLogger);
    const attemptsAfterFirstRun = fixture.state.loginAttempts;

    const second = await scrapeAlerts(config, silentLogger);
    assert.equal(second.diagnostics.reusedSession, true);
    assert.equal(
      fixture.state.loginAttempts,
      attemptsAfterFirstRun,
      'no additional login request should be made',
    );
    assert.equal(second.alerts.length, 2);
  });
});

test('a rejected password surfaces as a LoginError with the site message', { skip }, async () => {
  await withFixture(async ({ dir, fixture }) => {
    const config = loadConfig(
      testEnv(fixture.url, dir, { FOXESS_PASSWORD: 'wrong', MAX_ATTEMPTS: '1', RETRY_BACKOFF_MS: '0' }),
    );

    await assert.rejects(
      () => scrapeAlerts(config, silentLogger),
      (error) => {
        assert.equal(error.name, 'LoginError');
        assert.match(error.message, /Invalid credentials/);
        return true;
      },
    );
  });
});

test('--once --dry-run sends no mail, logs the preview and remembers the alerts', { skip }, async () => {
  await withFixture(async ({ dir, fixture }) => {
    const env = testEnv(fixture.url, dir, { DRY_RUN: 'true', LOG_LEVEL: 'info' });

    const first = await runCli(['--once', '--dry-run'], env);
    assert.equal(first.code, 0, `expected exit 0, got ${first.code}\n${first.stderr}`);
    assert.match(first.stdout, /starting alert check/);
    assert.match(first.stdout, /Grid Loss/, 'the dry-run preview lists the alert');
    assert.match(first.stdout, /dry-run: email not sent/);
    assert.match(first.stdout, /state not persisted/);

    // A dry run must not consume the backlog.
    await assert.rejects(() => readFile(join(dir, 'state.json'), 'utf8'), /ENOENT/);

    const second = await runCli(['--once', '--dry-run'], env);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /dry-run email body/, 'the same alerts are still pending');
    assert.ok(!second.stdout.includes('no new alerts to notify'));
  });
});

test('long-running mode serves /health and shuts down cleanly on SIGTERM', { skip }, async () => {
  await withFixture(async ({ dir, fixture }) => {
    const port = await freePort();
    const env = testEnv(fixture.url, dir, {
      DRY_RUN: 'true',
      LOG_LEVEL: 'info',
      HEALTH_PORT: String(port),
      POLL_INTERVAL_MINUTES: '60',
    });

    const cli = spawnCli([], env);
    try {
      const body = await waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          return { status: response.status, body: await response.json() };
        },
        (result) => result.status === 200 && result.body.lastRun?.status === 'ok',
        30_000,
      );
      assert.equal(body.status, 200);
      assert.equal(body.body.status, 'ok');
      assert.equal(body.body.lastRun.status, 'ok');
      // dry-run does not persist state, so nothing is remembered
      assert.equal(body.body.seenAlerts, 0);
      assert.ok(Date.parse(body.body.nextRunAt) > Date.now(), 'the next run is scheduled');
    } finally {
      cli.child.kill('SIGTERM');
    }

    const code = await cli.done;
    assert.equal(code, 0, `expected a clean shutdown\n${cli.stderr()}`);
    assert.match(cli.stdout(), /shutting down signal=SIGTERM/);
    assert.match(cli.stdout(), /stopped/);
  });
});

function spawnCli(args, env) {
  const child = spawn(process.execPath, ['src/index.js', ...args], {
    env: { ...process.env, ...env },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
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

  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

async function runCli(args, env) {
  const cli = spawnCli(args, env);
  const code = await cli.done;
  return { code, stdout: cli.stdout(), stderr: cli.stderr() };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(fn, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error('timed out waiting for condition');
}
