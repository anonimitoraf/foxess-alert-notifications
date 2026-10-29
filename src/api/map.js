/**
 * Maps FoxESS alarm records (from `/dew/w/v0/plant/alarm[Raw]`) into the generic
 * `Alert` shape used by de-duplication, policy and email rendering.
 *
 * A record looks like:
 *   {
 *     "device": "60KBEXAMPLE00001",
 *     "severity": "--",
 *     "code": "26",
 *     "msg": "Grid Voltage Fault",
 *     "category": "Inverter",
 *     "date": "2026-07-08 13:30:37 AEST",
 *     "recoveryDate": "2026-07-08 13:36:37 AEST"
 *   }
 */

import { alertId, normalizeSeverity } from '../alerts.js';
import { parseZonedDateTime } from '../time.js';

function clean(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' || text === '--' ? undefined : text;
}

/**
 * @param {object} record raw alarm row from the API
 * @param {{plant?: object, scope?: 'active'|'history', url?: string, timezone?: string}} context
 * @returns {import('../alerts.js').Alert|null}
 */
export function mapAlarmRecord(record, { plant, scope = 'active', url, timezone } = {}) {
  if (!record || typeof record !== 'object') return null;

  const code = clean(record.code);
  const message = clean(record.msg) ?? clean(record.message) ?? clean(record.name);
  if (!message && !code) return null;

  const title = message ?? `Alarm ${code}`;
  const category = clean(record.category);
  const tz = timezone || plant?.timezone || 'UTC';
  const occurred = parseZonedDateTime(record.date ?? record.occurTime ?? record.time, tz);
  const recovered = clean(record.recoveryDate);

  const details = [
    category,
    code ? `code ${code}` : undefined,
    recovered ? `recovered ${recovered}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const alert = {
    title,
    details: details || undefined,
    severity: normalizeSeverity(clean(record.severity), `${title} ${category ?? ''}`),
    occurredAt: occurred ? occurred.toISOString() : null,
    site: clean(plant?.plantName) ?? clean(plant?.name) ?? clean(plant?.plantID),
    device: clean(record.device) ?? clean(record.deviceSN),
    // The alarm code is part of the identity: two different faults on the same
    // device can share a timestamp and even a message.
    ref: [category ?? '', code ?? ''].join(':') || undefined,
    scope,
    // Keep the plant zone so the email can show alerts in local time.
    timezone: tz,
    source: 'api',
    url,
  };
  alert.id = alertId(alert);
  return alert;
}

export function mapAlarmList(records, context) {
  return (Array.isArray(records) ? records : []).map((record) => mapAlarmRecord(record, context)).filter(Boolean);
}
