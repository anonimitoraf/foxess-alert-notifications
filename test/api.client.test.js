import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient, extractToken, FoxessApiError, md5 } from '../src/api/client.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { alarm, startApiServer } from './fixtures/apiServer.js';

const silent = createLogger({ level: 'silent' });

function configFor(url, extra = {}) {
  return loadConfig({
    FOXESS_USERNAME: 'owner@example.com',
    FOXESS_PASSWORD: 'secret',
    FOXESS_BASE_URL: url,
    FOXESS_SIGNATURE: 'off',
    DRY_RUN: 'true',
    RUN_ONCE: 'true',
    STATE_FILE: '/tmp/foxess-test/state.json',
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

test('md5 matches the hash the web app sends', () => {
  assert.equal(md5('secret'), '5ebe2294ecd0e0f08eab7690d2a6ee69');
});

test('login posts account + md5(password) and stores the returned token', async () => {
  await withServer({}, async (server) => {
    const client = createApiClient(configFor(server.url), silent);
    await client.ensureToken();

    assert.equal(server.state.loginCalls, 1);
    const login = server.state.requests.find((request) => request.path === '/foxess/biz/auth/login');
    assert.equal(login.body.account, 'owner@example.com');
    assert.equal(login.body.password, md5('secret'), 'the password must never be sent in clear text');

    // Every request carries the headers the SPA sends.
    for (const header of ['lang', 'token', 'timezone', 'platform', 'x-auth-platform', 'dt', 'timestamp', 'signature']) {
      assert.ok(login.headers[header] !== undefined, `missing header ${header}`);
    }
    assert.equal(login.headers['x-auth-platform'], 'FOX_CLOUD_WEB_2_0');
    assert.match(login.headers.dt, /^UTC@\d+@\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(login.headers.token, '', 'login is anonymous');
    assert.equal(client.token, server.token);
  });
});

test('a supplied FOXESS_TOKEN skips the login call entirely', async () => {
  await withServer({}, async (server) => {
    const client = createApiClient(configFor(server.url, { FOXESS_TOKEN: server.token }), silent);
    await client.ensureToken();
    assert.equal(server.state.loginCalls, 0);
    assert.equal(await client.listPlants().then((plants) => plants.length), 1);
  });
});

test('wrong credentials surface the FoxESS error and hint', async () => {
  await withServer({}, async (server) => {
    const config = loadConfig({
      FOXESS_USERNAME: 'owner@example.com',
      FOXESS_PASSWORD: 'wrong',
      FOXESS_BASE_URL: server.url,
      FOXESS_SIGNATURE: 'off',
      DRY_RUN: 'true',
      STATE_FILE: '/tmp/foxess-test/state.json',
    });
    const client = createApiClient(config, silent);
    await assert.rejects(
      () => client.ensureToken(),
      (error) => {
        assert.ok(error instanceof FoxessApiError);
        assert.equal(error.errno, 41807);
        assert.match(error.message, /Wrong user name or password/);
        assert.match(error.hint, /credentials/);
        return true;
      },
    );
  });
});

test('an expired token triggers one re-login and a retry', async () => {
  await withServer({}, async (server) => {
    const client = createApiClient(configFor(server.url), silent);
    await client.ensureToken();

    server.state.failNextAuth = true;
    const plants = await client.listPlants();

    assert.equal(plants.length, 1);
    assert.equal(server.state.loginCalls, 2, 'the 41819 should have forced exactly one extra login');
  });
});

test('plants are paginated and de-duplicated', async () => {
  const plants = Array.from({ length: 5 }, (_, index) => ({
    plantID: `plant-${index}`,
    plantName: `Plant ${index}`,
    timezone: 'UTC',
  }));
  await withServer({ plants }, async (server) => {
    const client = createApiClient(configFor(server.url), silent);
    const result = await client.listPlants({ pageSize: 2 });
    assert.equal(result.length, 5);
    const listCalls = server.state.requests.filter((request) => request.path === '/dew/w/v0/plant/list');
    assert.equal(listCalls.length, 3, 'five plants at two per page = three calls');
  });
});

test('active alarms are fetched for the plant with its timezone', async () => {
  await withServer({ activeAlarms: { 'plant-1': [alarm()] } }, async (server) => {
    const client = createApiClient(configFor(server.url), silent);
    const { alarms, count } = await client.listActiveAlarms('plant-1', { timezone: 'Australia/Melbourne' });
    assert.equal(count, 1);
    assert.equal(alarms[0].code, '26');

    const call = server.state.requests.find((request) => request.path === '/dew/w/v0/plant/alarm');
    assert.deepEqual(call.body, { plantID: 'plant-1', category: null, severity: null, device: null });
    assert.equal(call.headers.timezone, 'Australia/Melbourne');
  });
});

test('history is queried in windows and merged without duplicates', async () => {
  const history = [
    alarm({ date: '2026-07-02 10:00:00 AEST' }),
    alarm({ date: '2026-07-08 13:30:37 AEST', code: '26' }),
    alarm({ date: '2026-07-08 13:30:37 AEST', code: '27', msg: 'Grid Frequency Fault' }),
    alarm({ date: '2026-08-20 09:04:56 AEST' }),
  ];
  await withServer({ historyAlarms: { 'plant-1': history } }, async (server) => {
    const client = createApiClient(configFor(server.url), silent);
    const { alarms, windows } = await client.listHistoryAlarms('plant-1', {
      from: new Date('2026-06-25T00:00:00Z'),
      to: new Date('2026-08-25T00:00:00Z'),
      timezone: 'Australia/Melbourne',
    });

    assert.ok(windows >= 5, `expected several 14-day windows, got ${windows}`);
    assert.equal(alarms.length, 4, 'window boundaries must not duplicate rows');
    assert.equal(server.state.historyCalls, windows);

    const first = server.state.requests.find((request) => request.path === '/dew/w/v0/plant/historyAlarm');
    assert.deepEqual(first.body.begin, { year: '2026', month: '06', day: '25' });
    assert.equal(first.body.realtimeFlag, false);
    assert.equal(first.body.exportFlag, false);
  });
});

test('a refreshed-token response header replaces the stored token', async () => {
  const rotated = 'biz-web-99999999-8888-7777-6666-555555555555';
  await withServer({ refreshedToken: rotated }, async (server) => {
    const client = createApiClient(configFor(server.url, { FOXESS_TOKEN: server.token }), silent);
    await client.listPlants();
    assert.equal(client.token, rotated);
  });
});

test('extractToken copes with the shapes a login response may take', () => {
  const token = 'biz-web-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(extractToken({ result: { token } }).token, token);
  assert.equal(extractToken({ result: { accessToken: token } }).token, token);
  assert.equal(extractToken({ result: { user: { loginToken: token } } }).token, token);
  assert.equal(extractToken({ result: { weird: token } }).token, token, 'shape based fallback');
  assert.equal(extractToken({ result: {} }).token, null);
  assert.equal(extractToken(null).token, null);
});
