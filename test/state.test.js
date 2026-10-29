import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createEmptyState,
  markNotified,
  markSeen,
  pruneSeen,
  readState,
  recordError,
  recordErrorNotified,
  recordRun,
  seenCount,
  shouldNotifyError,
  writeState,
} from '../src/state.js';

const NOW = new Date('2026-10-25T12:00:00.000Z');

test('markSeen reports only first-time alerts and counts repeats', () => {
  const state = createEmptyState(NOW);
  const first = markSeen(state, [{ id: 'a1', title: 'Grid Loss' }], NOW);
  assert.deepEqual(
    first.newAlerts.map((alert) => alert.id),
    ['a1'],
  );
  assert.equal(state.seen.a1.occurrences, 1);

  const second = markSeen(state, [{ id: 'a1', title: 'Grid Loss' }, { id: 'a2', title: 'Over Temp' }], NOW);
  assert.deepEqual(
    second.newAlerts.map((alert) => alert.id),
    ['a2'],
  );
  assert.equal(state.seen.a1.occurrences, 2);
  assert.equal(seenCount(state), 2);
});

test('markNotified timestamps the alerts that were emailed', () => {
  const state = createEmptyState(NOW);
  const alerts = [{ id: 'a1', title: 'Grid Loss' }, { id: 'a2', title: 'Over Temp' }];
  markSeen(state, alerts, NOW);
  markNotified(state, [alerts[1]], NOW);
  assert.equal(state.seen.a1.notifiedAt, null);
  assert.equal(state.seen.a2.notifiedAt, NOW.toISOString());
});

test('pruneSeen drops alerts that have not been seen within the retention window', () => {
  const state = createEmptyState(NOW);
  state.seen = {
    fresh: { firstSeenAt: '2026-10-25T11:00:00.000Z', lastSeenAt: '2026-10-25T11:00:00.000Z' },
    stale: { firstSeenAt: '2026-09-01T11:00:00.000Z', lastSeenAt: '2026-09-01T11:00:00.000Z' },
  };
  const removed = pruneSeen(state, { now: NOW, retentionDays: 30 });
  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(state.seen), ['fresh']);
});

test('error notifications respect the cooldown window', () => {
  const state = createEmptyState(NOW);
  assert.equal(shouldNotifyError(state, { now: NOW, cooldownHours: 6 }), true);

  recordErrorNotified(state, NOW);
  assert.equal(shouldNotifyError(state, { now: new Date(NOW.getTime() + 60_000), cooldownHours: 6 }), false);
  assert.equal(shouldNotifyError(state, { now: new Date(NOW.getTime() + 6 * 3600_000), cooldownHours: 6 }), true);
});

test('recordRun and recordError update the run metadata', () => {
  const state = createEmptyState(NOW);
  recordRun(state, { status: 'ok', alertsInWindow: 3 }, NOW);
  assert.equal(state.lastRun.status, 'ok');
  assert.equal(state.lastRunAt, NOW.toISOString());
  assert.equal(state.firstRunCompletedAt, NOW.toISOString());

  recordError(state, new Error('boom'), NOW);
  assert.equal(state.lastError.message, 'boom');
});

test('a failed run does not mark the first run as completed', () => {
  const state = createEmptyState(NOW);
  recordRun(state, { status: 'error' }, NOW, { markFirstRun: false });
  assert.equal(state.firstRunCompletedAt, null, 'the next successful run is still a first run');
  assert.equal(state.lastRun.status, 'error');

  recordRun(state, { status: 'ok' }, NOW);
  assert.equal(state.firstRunCompletedAt, NOW.toISOString());
});

test('state survives a write/read round trip and corrupt files recover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foxess-state-'));
  const file = join(dir, 'nested', 'state.json');
  try {
    const state = createEmptyState(NOW);
    markSeen(state, [{ id: 'a1', title: 'Grid Loss' }], NOW);
    recordRun(state, { status: 'ok' }, NOW);
    await writeState(file, state);

    const reloaded = await readState(file);
    assert.equal(reloaded.seen.a1.title, 'Grid Loss');
    assert.equal(reloaded.lastRun.status, 'ok');

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.version, 1, 'state file is written with a version marker');

    await writeFile(file, '{ not json', 'utf8');
    const recovered = await readState(file);
    assert.equal(seenCount(recovered), 0);
    assert.equal(recovered.recoveredFromCorruptState, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readState treats a missing file as a first run', async () => {
  const state = await readState(join(tmpdir(), 'definitely-missing-dir', 'state.json'));
  assert.equal(seenCount(state), 0);
  assert.equal(state.firstRunCompletedAt, null);
});
