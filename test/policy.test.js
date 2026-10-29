import assert from 'node:assert/strict';
import test from 'node:test';

import { capAlerts, selectNotifications } from '../src/policy.js';

const alerts = [{ id: 'a', title: 'Grid Loss' }];
const newAlerts = [{ id: 'b', title: 'Over Temperature' }];

const config = (overrides = {}) => ({ alerts: { notifyMode: 'new', notifyOnFirstRun: true, ...overrides } });

test('NOTIFY_MODE=all always sends every alert in the window', () => {
  const selected = selectNotifications({
    alerts,
    newAlerts,
    isFirstRun: false,
    config: config({ notifyMode: 'all' }),
  });
  assert.deepEqual(selected, alerts);
});

test('NOTIFY_MODE=new sends only alerts never seen before', () => {
  const selected = selectNotifications({ alerts, newAlerts, isFirstRun: false, config: config() });
  assert.deepEqual(selected, newAlerts);
});

test('the first run honours NOTIFY_ON_FIRST_RUN', () => {
  const yes = selectNotifications({ alerts, newAlerts, isFirstRun: true, config: config({ notifyOnFirstRun: true }) });
  assert.deepEqual(yes, alerts, 'the existing backlog is emailed by default');

  const no = selectNotifications({ alerts, newAlerts, isFirstRun: true, config: config({ notifyOnFirstRun: false }) });
  assert.deepEqual(no, [], 'a silent first run only records the backlog');
});

test('nothing is selected when there are no alerts', () => {
  assert.deepEqual(selectNotifications({ alerts: [], newAlerts: [], isFirstRun: false, config: config() }), []);
});

test('capAlerts truncates long lists and reports the remainder', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: String(index) }));
  const { alerts: capped, truncated } = capAlerts(many, 50);
  assert.equal(capped.length, 50);
  assert.equal(truncated, 70);

  const exact = capAlerts(many.slice(0, 3), 50);
  assert.equal(exact.alerts.length, 3);
  assert.equal(exact.truncated, 0);
});
