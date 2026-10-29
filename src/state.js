/**
 * Tiny JSON state store.
 *
 * The state file is what makes the worker trustworthy: it remembers which
 * alerts were already emailed so a 30 minute poll does not spam the same
 * inverter fault twelve times an hour, and it stores the browser session so we
 * only log in when the token actually expired.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATE_VERSION = 1;

export function createEmptyState(now = new Date()) {
  return {
    version: STATE_VERSION,
    createdAt: now.toISOString(),
    lastRunAt: null,
    lastRun: null,
    lastError: null,
    lastErrorNotifiedAt: null,
    firstRunCompletedAt: null,
    seen: {},
  };
}

export async function readState(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) {
      return createEmptyState();
    }
    return {
      ...createEmptyState(),
      ...parsed,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') return createEmptyState();
    if (error instanceof SyntaxError) {
      // Corrupt state should never stop alerting; start over.
      return { ...createEmptyState(), recoveredFromCorruptState: true };
    }
    throw error;
  }
}

export async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file); // atomic on POSIX: a crash mid-write cannot truncate state
}

/**
 * Records the given alerts as seen and returns the subset that had never been
 * seen before (in stable order).
 */
export function markSeen(state, alerts, now = new Date()) {
  const timestamp = now.toISOString();
  const newAlerts = [];
  for (const alert of alerts) {
    const existing = state.seen[alert.id];
    if (existing) {
      existing.lastSeenAt = timestamp;
      existing.occurrences = (existing.occurrences ?? 1) + 1;
      continue;
    }
    state.seen[alert.id] = {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      notifiedAt: null,
      occurrences: 1,
      title: alert.title,
      severity: alert.severity,
      occurredAt: alert.occurredAt,
      device: alert.device,
      site: alert.site,
    };
    newAlerts.push(alert);
  }
  return { newAlerts };
}

export function markNotified(state, alerts, now = new Date()) {
  const timestamp = now.toISOString();
  for (const alert of alerts) {
    const entry = state.seen[alert.id];
    if (entry) entry.notifiedAt = timestamp;
  }
}

/** Drops alerts that have not been observed for `retentionDays`. */
export function pruneSeen(state, { now = new Date(), retentionDays = 30 } = {}) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, entry] of Object.entries(state.seen)) {
    const last = Date.parse(entry.lastSeenAt ?? entry.firstSeenAt ?? '');
    if (Number.isNaN(last) || last < cutoff) {
      delete state.seen[id];
      removed += 1;
    }
  }
  return removed;
}

export function recordRun(state, summary, now = new Date(), { markFirstRun = true } = {}) {
  const timestamp = now.toISOString();
  state.lastRunAt = timestamp;
  state.lastRun = { at: timestamp, ...summary };
  if (markFirstRun && !state.firstRunCompletedAt) state.firstRunCompletedAt = timestamp;
  return state;
}

export function recordError(state, error, now = new Date()) {
  state.lastError = {
    at: now.toISOString(),
    message: error?.message ? String(error.message) : String(error),
    name: error?.name,
  };
  return state;
}

export function shouldNotifyError(state, { now = new Date(), cooldownHours = 6 } = {}) {
  const last = state.lastErrorNotifiedAt ? Date.parse(state.lastErrorNotifiedAt) : NaN;
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= cooldownHours * 60 * 60 * 1000;
}

export function recordErrorNotified(state, now = new Date()) {
  state.lastErrorNotifiedAt = now.toISOString();
  return state;
}

export function seenCount(state) {
  return Object.keys(state.seen ?? {}).length;
}
