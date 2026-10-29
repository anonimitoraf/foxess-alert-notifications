import assert from 'node:assert/strict';
import test from 'node:test';

import { datePartsInZone, formatInZone, isValidTimeZone, parseZonedDateTime, zonedTimeToUtc } from '../src/time.js';

test('a wall clock in a zone converts to the right UTC instant', () => {
  // July in Melbourne is AEST (+10).
  const date = parseZonedDateTime('2026-07-08 13:30:37 AEST', 'Australia/Melbourne');
  assert.equal(date.toISOString(), '2026-07-08T03:30:37.000Z');

  // January in Melbourne is AEDT (+11): same wall clock, different instant.
  const summer = parseZonedDateTime('2026-01-08 13:30:37 AEDT', 'Australia/Melbourne');
  assert.equal(summer.toISOString(), '2026-01-08T02:30:37.000Z');
});

test('zone abbreviations are ignored in favour of the IANA zone', () => {
  // "CST" means three different things worldwide; the plant zone wins.
  const europe = parseZonedDateTime('2026-07-08 13:30:37 CST', 'Europe/Madrid');
  assert.equal(europe.toISOString(), '2026-07-08T11:30:37.000Z');
  const chicago = parseZonedDateTime('2026-07-08 13:30:37 CST', 'America/Chicago');
  assert.equal(chicago.toISOString(), '2026-07-08T18:30:37.000Z');
});

test('explicit offsets and Z are honoured', () => {
  assert.equal(parseZonedDateTime('2026-07-08T13:30:37Z', 'Australia/Melbourne').toISOString(), '2026-07-08T13:30:37.000Z');
  assert.equal(parseZonedDateTime('2026-07-08 13:30:37 +02:00', 'UTC').toISOString(), '2026-07-08T11:30:37.000Z');
  assert.equal(parseZonedDateTime('2026-07-08 13:30:37 -0500', 'UTC').toISOString(), '2026-07-08T18:30:37.000Z');
});

test('formats without seconds and with milliseconds are accepted', () => {
  assert.equal(parseZonedDateTime('2026-07-08 13:30', 'UTC').toISOString(), '2026-07-08T13:30:00.000Z');
  assert.equal(parseZonedDateTime('2026-07-08 13:30:37.250', 'UTC').toISOString(), '2026-07-08T13:30:37.250Z');
});

test('invalid input returns null instead of an invalid Date', () => {
  for (const value of ['', 'not a date', '2026-13-01 00:00:00', '2026-02-31 10:00:00', '2026-07-08 25:00:00', null, undefined, 42]) {
    assert.equal(parseZonedDateTime(value, 'UTC'), null, `expected null for ${String(value)}`);
  }
});

test('DST transitions pick the offset that applies at that instant', () => {
  // Melbourne DST starts 2026-10-04 02:00 (2:00 -> 3:00). 05:00 local is AEDT.
  assert.equal(parseZonedDateTime('2026-10-04 05:00:00', 'Australia/Melbourne').toISOString(), '2026-10-03T18:00:00.000Z');
  // ...while 01:00 the same night is still AEST.
  assert.equal(parseZonedDateTime('2026-10-04 01:00:00', 'Australia/Melbourne').toISOString(), '2026-10-03T15:00:00.000Z');
});

test('zonedTimeToUtc handles a UTC zone and validates the inputs', () => {
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 7, day: 8, hour: 13, minute: 30, second: 37 }, 'UTC').toISOString(),
    '2026-07-08T13:30:37.000Z',
  );
});

test('formatInZone and datePartsInZone round trip', () => {
  const instant = new Date('2026-07-08T03:30:37.000Z');
  assert.equal(formatInZone(instant, 'Australia/Melbourne'), '2026-07-08 13:30:37');
  assert.deepEqual(datePartsInZone(instant, 'Australia/Melbourne'), { year: '2026', month: '07', day: '08' });
  assert.deepEqual(datePartsInZone(new Date('2026-01-05T23:30:00Z'), 'Australia/Melbourne'), {
    year: '2026',
    month: '01',
    day: '06',
  });
});

test('isValidTimeZone rejects nonsense', () => {
  assert.equal(isValidTimeZone('Australia/Melbourne'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});
