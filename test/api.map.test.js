import assert from 'node:assert/strict';
import test from 'node:test';

import { mapAlarmList, mapAlarmRecord } from '../src/api/map.js';

const PLANT = { plantID: 'plant-1', plantName: 'Home Roof', timezone: 'Australia/Melbourne' };

// Shaped exactly like a live /dew/w/v0/plant/historyAlarm response (serial anonymised).
const RECORD = {
  device: '60KBEXAMPLE00001',
  severity: '--',
  code: '26',
  msg: 'Grid Voltage Fault',
  category: 'Inverter',
  date: '2026-07-08 13:30:37 AEST',
  recoveryDate: '2026-07-08 13:36:37 AEST',
};

test('maps a real alarm record', () => {
  const alert = mapAlarmRecord(RECORD, { plant: PLANT, scope: 'history', url: 'https://x/v2/plants/alarm' });

  assert.equal(alert.title, 'Grid Voltage Fault');
  assert.equal(alert.device, '60KBEXAMPLE00001');
  assert.equal(alert.site, 'Home Roof');
  assert.equal(alert.severity, 'critical', '"Fault" means critical');
  assert.equal(alert.occurredAt, '2026-07-08T03:30:37.000Z', 'AEST is +10');
  assert.equal(alert.source, 'api');
  assert.equal(alert.scope, 'history');
  assert.equal(alert.ref, 'Inverter:26');
  assert.equal(alert.timezone, 'Australia/Melbourne', 'the zone travels with the alert');
  assert.match(alert.details, /Inverter · code 26 · recovered 2026-07-08 13:36:37 AEST/);
  assert.equal(alert.id.length, 16);
});

test('the alarm code is part of the identity', () => {
  const voltage = mapAlarmRecord({ ...RECORD, code: '26', msg: 'Grid Fault' }, { plant: PLANT });
  const frequency = mapAlarmRecord({ ...RECORD, code: '27', msg: 'Grid Fault' }, { plant: PLANT });
  assert.equal(voltage.title, frequency.title);
  assert.equal(voltage.occurredAt, frequency.occurredAt);
  assert.notEqual(voltage.id, frequency.id, 'different codes must not collapse into one alert');
});

test('unknown and placeholder severities are kept, not dropped', () => {
  const alert = mapAlarmRecord({ ...RECORD, code: '1', msg: 'No Utility', severity: '--' }, { plant: PLANT });
  assert.equal(alert.severity, 'unknown');
  assert.equal(alert.title, 'No Utility');
});

test('explicit severity labels are honoured', () => {
  assert.equal(mapAlarmRecord({ ...RECORD, severity: 'Warning', msg: 'Something' }, { plant: PLANT }).severity, 'warning');
  assert.equal(mapAlarmRecord({ ...RECORD, severity: '2', msg: 'Something' }, { plant: PLANT }).severity, 'warning');
  assert.equal(mapAlarmRecord({ ...RECORD, severity: 'Fault', msg: 'Something' }, { plant: PLANT }).severity, 'critical');
});

test('a plant without a name falls back to its id, and a record without a device still maps', () => {
  const alert = mapAlarmRecord(
    { ...RECORD, device: undefined },
    { plant: { plantID: 'plant-9', timezone: 'UTC' } },
  );
  assert.equal(alert.site, 'plant-9');
  assert.equal(alert.device, undefined);
  assert.ok(alert.id);
});

test('an active alarm without a recovery date has no recovery detail', () => {
  const alert = mapAlarmRecord({ ...RECORD, recoveryDate: undefined }, { plant: PLANT, scope: 'active' });
  assert.equal(alert.scope, 'active');
  assert.ok(!alert.details.includes('recovered'));
});

test('records without a message or code are ignored', () => {
  assert.equal(mapAlarmRecord({ device: 'x', category: 'Inverter' }, { plant: PLANT }), null);
  assert.equal(mapAlarmRecord(null, { plant: PLANT }), null);
});

test('a record with only a code still produces a usable title', () => {
  const alert = mapAlarmRecord({ device: 'x', code: '99', date: '2026-07-08 13:30:37 AEST' }, { plant: PLANT });
  assert.equal(alert.title, 'Alarm 99');
});

test('mapAlarmList maps every record and tolerates junk', () => {
  const alerts = mapAlarmList([RECORD, null, { device: 'x' }, { ...RECORD, code: '1', msg: 'No Utility' }], {
    plant: PLANT,
  });
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((alert) => alert.title),
    ['Grid Voltage Fault', 'No Utility'],
  );
  assert.equal(mapAlarmList(undefined, { plant: PLANT }).length, 0);
});
