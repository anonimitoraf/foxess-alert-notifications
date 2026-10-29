import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, loadConfig, resolveRoute } from '../src/config.js';

const MINIMAL = {
  FOXESS_USERNAME: 'owner@example.com',
  FOXESS_PASSWORD: 'hunter2',
  SMTP_HOST: 'smtp.example.com',
  MAIL_TO: 'me@example.com',
};

test('loadConfig applies safe defaults', () => {
  const config = loadConfig(MINIMAL);

  assert.equal(config.foxess.baseUrl, 'https://www.foxesscloud.com');
  assert.equal(config.foxess.loginUrl, 'https://www.foxesscloud.com/login');
  assert.deepEqual(config.foxess.alertsUrls, ['https://www.foxesscloud.com/bus/alarm']);
  assert.equal(config.foxess.mode, 'api');
  assert.equal(config.foxess.headless, true);
  assert.equal(config.schedule.intervalMs, 30 * 60_000);
  assert.equal(config.alerts.lookbackHours, 24);
  assert.equal(config.alerts.notifyMode, 'new');
  assert.equal(config.alerts.minSeverity, 'unknown', 'unknown severities are kept by default');
  assert.equal(config.api.scope, 'both');
  assert.equal(config.api.loginPath, '/foxess/biz/auth/login');
  assert.equal(config.foxess.signatureMode, 'auto');
  assert.equal(config.api.historyChunkDays, 14);
  assert.equal(config.alerts.notifyOnError, true);
  assert.equal(config.mail.port, 587);
  assert.equal(config.mail.secure, false);
  assert.deepEqual(config.mail.to, ['me@example.com']);
  assert.equal(config.runtime.healthPort, 8080);
  assert.equal(config.runtime.dryRun, false);
});

test('loadConfig parses lists, booleans, numbers and regexes', () => {
  const config = loadConfig({
    ...MINIMAL,
    MAIL_TO: 'a@example.com, b@example.com ,',
    MAIL_CC: 'cc@example.com',
    SMTP_PORT: '465',
    POLL_INTERVAL_MINUTES: '5',
    ALERT_LOOKBACK_HOURS: '2.5',
    NOTIFY_MODE: 'ALL',
    FOXESS_ALERTS_ROUTES: '/bus/alarm, /bus/index,/plant',
    ALERT_RESPONSE_URL_REGEX: 'alarm|fault',
    RUN_ONCE: 'yes',
    DRY_RUN: 'true',
  });

  assert.deepEqual(config.mail.to, ['a@example.com', 'b@example.com']);
  assert.deepEqual(config.mail.cc, ['cc@example.com']);
  assert.equal(config.mail.secure, true, 'port 465 implies implicit TLS');
  assert.equal(config.schedule.intervalMs, 5 * 60_000);
  assert.equal(config.alerts.lookbackHours, 2.5);
  assert.equal(config.alerts.notifyMode, 'all');
  assert.equal(config.foxess.routes.length, 3);
  assert.equal(config.foxess.alertsUrls[2], 'https://www.foxesscloud.com/plant');
  assert.equal(config.foxess.responseUrlPattern.test('https://x/c/v0/fault/list'), true);
  assert.equal(config.schedule.runOnce, true);
  assert.equal(config.runtime.dryRun, true);
});

test('loadConfig requires credentials in api mode', () => {
  assert.throws(() => loadConfig({ MAIL_TO: 'me@example.com', SMTP_HOST: 'smtp' }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /FOXESS_USERNAME and FOXESS_PASSWORD are required/);
    return true;
  });
  assert.throws(() => loadConfig({ FOXESS_USERNAME: 'u', MAIL_TO: 'm@e.com', SMTP_HOST: 'smtp' }), /FOXESS_PASSWORD is required/);
});

test('a static token is enough in api mode', () => {
  const config = loadConfig({ FOXESS_TOKEN: 'biz-web-token', MAIL_TO: 'm@e.com', SMTP_HOST: 'smtp' });
  assert.equal(config.api.token, 'biz-web-token');
});

test('browser mode still requires a username and password', () => {
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_MODE: 'browser', FOXESS_USERNAME: '', FOXESS_PASSWORD: '' }), /FOXESS_USERNAME is required/);
  const config = loadConfig({ ...MINIMAL, FOXESS_MODE: 'browser' });
  assert.equal(config.foxess.mode, 'browser');
});

test('loadConfig requires SMTP details unless dry-run or json transport', () => {
  assert.throws(() => loadConfig({ FOXESS_USERNAME: 'u', FOXESS_PASSWORD: 'p' }), /SMTP_HOST is required/);

  const dry = loadConfig({ FOXESS_USERNAME: 'u', FOXESS_PASSWORD: 'p', DRY_RUN: 'true' });
  assert.equal(dry.runtime.dryRun, true);

  const json = loadConfig({ FOXESS_USERNAME: 'u', FOXESS_PASSWORD: 'p', MAIL_TRANSPORT: 'json' });
  assert.equal(json.mail.transport, 'json');
});

test('loadConfig rejects malformed values', () => {
  assert.throws(() => loadConfig({ ...MINIMAL, POLL_INTERVAL_MINUTES: 'soon' }), /must be an integer/);
  assert.throws(() => loadConfig({ ...MINIMAL, POLL_INTERVAL_MINUTES: '0' }), /must be between/);
  assert.throws(() => loadConfig({ ...MINIMAL, HEADLESS: 'maybe' }), /must be a boolean/);
  assert.throws(() => loadConfig({ ...MINIMAL, ALERT_RESPONSE_URL_REGEX: '([' }), /not a valid regular expression/);
  assert.throws(() => loadConfig({ ...MINIMAL, NOTIFY_MODE: 'sometimes' }), /NOTIFY_MODE/);
  assert.throws(() => loadConfig({ ...MINIMAL, MAIL_TRANSPORT: 'pigeon' }), /MAIL_TRANSPORT/);
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_PAGE_ACTIONS: '[' }), /valid JSON/);
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_PAGE_ACTIONS: '{"goto":"/x"}' }), /must be a JSON array/);
});

test('loadConfig validates the mode, scope and signature switches', () => {
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_MODE: 'scrape' }), /FOXESS_MODE/);
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_ALERT_SCOPE: 'everything' }), /FOXESS_ALERT_SCOPE/);
  assert.throws(() => loadConfig({ ...MINIMAL, FOXESS_SIGNATURE: 'maybe' }), /FOXESS_SIGNATURE/);
  assert.equal(loadConfig({ ...MINIMAL, FOXESS_ALERT_SCOPE: 'active' }).api.scope, 'active');
  assert.deepEqual(loadConfig({ ...MINIMAL, FOXESS_PLANT_IDS: 'a, b' }).api.plantIds, ['a', 'b']);
});

test('loadConfig parses the page action DSL', () => {
  const actions = [{ goto: '/bus/alarm' }, { fill: { selector: 'input', value: 'SN-1' } }, { wait: 500 }];
  const config = loadConfig({ ...MINIMAL, FOXESS_PAGE_ACTIONS: JSON.stringify(actions) });
  assert.deepEqual(config.foxess.pageActions, actions);
});

test('loadConfig keeps EXACTLY the configured routes', () => {
  const config = loadConfig({ ...MINIMAL, FOXESS_ALERTS_ROUTES: 'https://other.test/#/alarm' });
  assert.deepEqual(config.foxess.alertsUrls, ['https://other.test/#/alarm']);
});

test('resolveRoute builds history-mode urls and passes through absolute/explicit hash urls', () => {
  assert.equal(resolveRoute('https://site.test/', '/bus/alarm'), 'https://site.test/bus/alarm');
  assert.equal(resolveRoute('https://site.test', 'bus/alarm'), 'https://site.test/bus/alarm');
  assert.equal(resolveRoute('https://site.test', '/#/bus/alarm'), 'https://site.test/#/bus/alarm');
  assert.equal(resolveRoute('https://site.test', 'https://x.test/#/a'), 'https://x.test/#/a');
});
