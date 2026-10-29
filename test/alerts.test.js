import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alertId,
  buildUnreadSignalAlert,
  dedupeAlerts,
  extractAlertsFromPayload,
  extractUnreadSignal,
  filterBySeverity,
  filterByWindow,
  normalizeSeverity,
  parseWhen,
  rowToAlert,
  sortAlerts,
  summarize,
  toAlert,
} from '../src/alerts.js';

const NOW = new Date('2026-10-25T12:00:00.000Z');

test('parseWhen understands the formats FoxESS renders', () => {
  assert.equal(parseWhen('2026-10-25T10:22:33Z').toISOString(), '2026-10-25T10:22:33.000Z');
  assert.equal(parseWhen('2026-10-25 10:22:33').getSeconds(), 33);
  assert.equal(parseWhen('2026年10月25日 10:22').getFullYear(), 2026);
  assert.equal(parseWhen(1761387753).toISOString(), '2025-10-25T10:22:33.000Z');
  assert.equal(parseWhen(1761387753000).toISOString(), '2025-10-25T10:22:33.000Z');
  assert.equal(parseWhen('25/10/2026 10:22').getDate(), 25, 'day-first dates are understood');
  const local = parseWhen('2026-10-25 10:22:33');
  assert.deepEqual(
    [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours()],
    [2026, 10, 25, 10],
    'naive timestamps are interpreted in the container timezone',
  );
});

test('parseWhen rejects garbage, pre-2000 and far-future values', () => {
  assert.equal(parseWhen('not a date'), null);
  assert.equal(parseWhen(''), null);
  assert.equal(parseWhen(null), null);
  assert.equal(parseWhen(undefined), null);
  assert.equal(parseWhen('1998-01-01 00:00:00'), null);
  assert.equal(parseWhen('2099-01-01 00:00:00'), null);
});

test('normalizeSeverity maps both numeric levels and free text', () => {
  assert.equal(normalizeSeverity(4), 'critical');
  assert.equal(normalizeSeverity(3), 'critical');
  assert.equal(normalizeSeverity(2), 'warning');
  assert.equal(normalizeSeverity(1), 'info');
  assert.equal(normalizeSeverity('Fault'), 'critical');
  assert.equal(normalizeSeverity('Warning'), 'warning');
  assert.equal(normalizeSeverity('Notice'), 'info');
  assert.equal(normalizeSeverity(null, 'Battery Over Temperature'), 'critical');
  assert.equal(normalizeSeverity('', 'something unclassifiable'), 'unknown');
});

test('toAlert maps a FoxESS alarm record', () => {
  const alert = toAlert({
    alarmName: 'Grid Loss',
    deviceSN: 'SN-0001',
    plantName: 'Home Roof',
    occurTime: '2026-10-25 10:22:33',
    alarmLevel: 2,
  });

  assert.equal(alert.title, 'Grid Loss');
  assert.equal(alert.device, 'SN-0001');
  assert.equal(alert.site, 'Home Roof');
  assert.equal(alert.severity, 'warning');
  assert.equal(alert.source, 'network');
  const occurred = new Date(alert.occurredAt);
  assert.deepEqual(
    [occurred.getFullYear(), occurred.getMonth() + 1, occurred.getDate(), occurred.getHours(), occurred.getMinutes()],
    [2026, 10, 25, 10, 22],
  );
  assert.equal(alert.id.length, 16);
});

test('toAlert never turns a numeric discriminator into a title', () => {
  assert.equal(toAlert({ type: 2, createTime: '2026-10-25 10:00:00' }), null);
  assert.equal(toAlert({ alarmType: 'Battery', createTime: '2026-10-25 10:00:00' }).title, 'Battery');
});

test('toAlert ignores objects that do not look like alerts', () => {
  assert.equal(toAlert({ value: 12, time: '2026-10-25 10:00:00' }), null);
  assert.equal(toAlert(null), null);
  assert.equal(toAlert([]), null);
});

test('alert ids are stable for identical content and differ otherwise', () => {
  const base = { title: 'Grid Loss', device: 'SN-1', site: 'A', occurredAt: '2026-10-25T10:00:00.000Z' };
  const a = alertId(base);
  const b = alertId({ ...base, title: '  grid   loss ' });
  const c = alertId({ ...base, device: 'SN-2' });
  assert.equal(a, b, 'whitespace and casing must not change identity');
  assert.notEqual(a, c);
  assert.notEqual(alertId({ ...base, ref: 'Inverter:26' }), alertId({ ...base, ref: 'Inverter:27' }), 'ref disambiguates');
});

test('extractAlertsFromPayload finds nested result.data arrays', () => {
  const payload = {
    errno: 0,
    result: {
      total: 2,
      data: [
        { alarmName: 'Grid Loss', deviceSN: 'SN-1', occurTime: '2026-10-25 10:00:00' },
        { faultName: 'Over Temperature', deviceSN: 'SN-1', createTime: '2026-10-25 09:00:00' },
      ],
    },
  };

  const alerts = extractAlertsFromPayload(payload, { url: 'https://example.test/c/v0/alarm/query' });
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((alert) => alert.title),
    ['Grid Loss', 'Over Temperature'],
  );
  assert.equal(alerts[0].url, 'https://example.test/c/v0/alarm/query');
});

test('extractAlertsFromPayload does not duplicate identical rows', () => {
  const row = { alarmName: 'Grid Loss', deviceSN: 'SN-1', occurTime: '2026-10-25 10:00:00' };
  const alerts = extractAlertsFromPayload({ result: { data: [row, { ...row }] } });
  assert.equal(alerts.length, 1);
});

test('filterByWindow keeps recent and timestamp-less alerts, drops old ones', () => {
  const alerts = [
    { id: 'recent', occurredAt: '2026-10-25T11:00:00.000Z' },
    { id: 'old', occurredAt: '2026-10-20T11:00:00.000Z' },
    { id: 'unknown', occurredAt: null },
  ];
  const { recent, ignored } = filterByWindow(alerts, { now: NOW, lookbackHours: 24 });
  assert.deepEqual(
    recent.map((alert) => alert.id),
    ['recent', 'unknown'],
  );
  assert.deepEqual(
    ignored.map((alert) => alert.id),
    ['old'],
  );

  const noWindow = filterByWindow(alerts, { now: NOW, lookbackHours: 0 });
  assert.equal(noWindow.recent.length, 3);
  assert.equal(noWindow.ignored.length, 0);
});

test('filterBySeverity uses the minimum severity threshold', () => {
  const alerts = [
    { severity: 'critical' },
    { severity: 'warning' },
    { severity: 'info' },
    { severity: 'unknown' },
  ];
  assert.equal(filterBySeverity(alerts, 'info').length, 3);
  assert.equal(filterBySeverity(alerts, 'warning').length, 2);
  assert.equal(filterBySeverity(alerts, 'critical').length, 1);
  assert.equal(filterBySeverity(alerts, 'unknown').length, 4, 'unknown is the permissive floor');
  assert.equal(filterBySeverity(alerts, 'nonsense').length, 4, 'invalid thresholds fall back to permissive');
});

test('sortAlerts orders by severity then most recent first', () => {
  const alerts = [
    { id: 'i1', severity: 'info', occurredAt: '2026-10-25T11:00:00.000Z' },
    { id: 'c1', severity: 'critical', occurredAt: '2026-10-25T09:00:00.000Z' },
    { id: 'c2', severity: 'critical', occurredAt: '2026-10-25T10:00:00.000Z' },
  ];
  assert.deepEqual(
    sortAlerts(alerts).map((alert) => alert.id),
    ['c2', 'c1', 'i1'],
  );
});

test('summarize counts severities and distinct devices/sites', () => {
  const summary = summarize([
    { severity: 'critical', device: 'SN-1', site: 'A' },
    { severity: 'critical', device: 'SN-1', site: 'A' },
    { severity: 'info', device: 'SN-2', site: 'B' },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySeverity.critical, 2);
  assert.equal(summary.bySeverity.info, 1);
  assert.equal(summary.devices, 2);
  assert.equal(summary.sites, 2);
});

test('dedupeAlerts collapses network + DOM duplicates, preferring the richer record', () => {
  const record = { alarmName: 'Grid Loss', deviceSN: 'SN-1', plantName: 'A', occurTime: '2026-10-25 10:00:00' };
  const network = toAlert(record, { source: 'network' });
  const dom = rowToAlert({
    headers: ['Time', 'Site', 'Device', 'Alarm'],
    cells: ['2026-10-25 10:00:00', 'A', 'SN-1', 'Grid Loss'],
  });

  assert.equal(network.id, dom.id, 'same alert must produce the same id from either source');

  const merged = dedupeAlerts([dom, network]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'network');
});

test('rowToAlert maps a rendered table row and falls back for unusual headers', () => {
  const alert = rowToAlert({
    headers: ['Occurred', 'Plant', 'Inverter SN', 'Detail'],
    cells: ['2026-10-25 11:30:00', 'Home Roof', 'SN-0001', 'Battery Over Temperature'],
  });
  assert.equal(alert.title, 'Battery Over Temperature');
  assert.equal(alert.device, 'SN-0001');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.source, 'dom');

  const fallback = rowToAlert({
    headers: [],
    cells: ['2026-10-25 11:30:00', 'Battery Over Temperature'],
  });
  assert.equal(fallback.title, 'Battery Over Temperature');
  assert.match(fallback.occurredAt, /T/);
});

test('rowToAlert ignores empty rows', () => {
  assert.equal(rowToAlert({ headers: ['Alarm'], cells: [''] }), null);
  assert.equal(rowToAlert({ headers: [], cells: [] }), null);
});

test('extractUnreadSignal only trusts unread-specific counters', () => {
  assert.deepEqual(extractUnreadSignal({ result: { unReadNum: 3 } }), { count: 3, key: 'unReadNum' });
  assert.deepEqual(extractUnreadSignal({ result: { data: { noticeCount: '7' } } }), { count: 7, key: 'noticeCount' });
  assert.equal(extractUnreadSignal({ result: { total: 42 } }), null, 'a generic total is not an unread signal');
  assert.equal(extractUnreadSignal({ result: { data: [] } }), null);
  assert.equal(extractUnreadSignal(null), null);
});

test('extractUnreadSignal reports the largest counter it finds', () => {
  const signal = extractUnreadSignal({ a: { unreadCount: 1 }, b: { unReadNum: 9 } });
  assert.deepEqual(signal, { count: 9, key: 'unReadNum' });
});

test('buildUnreadSignalAlert is stable per count so it emails once per change', () => {
  const first = buildUnreadSignalAlert({ count: 2 }, { url: 'https://example.test/x', now: NOW });
  const second = buildUnreadSignalAlert({ count: 2 }, { url: 'https://example.test/x', now: new Date() });
  const third = buildUnreadSignalAlert({ count: 3 }, { url: 'https://example.test/x', now: NOW });

  assert.equal(first.id, second.id);
  assert.notEqual(first.id, third.id);
  assert.equal(first.severity, 'info');
  assert.match(first.title, /2 unread notifications/);
  assert.equal(buildUnreadSignalAlert({ count: 1 }).title.includes('1 unread notification'), true);
});
