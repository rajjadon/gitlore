import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateSnoozeState,
  isSnoozedNow,
  snoozeUntil,
  unsnooze,
  pruneSnoozed,
  stampLegacySnoozes,
  type SnoozeStore,
} from '../../../../src/core/forge/snoozeStore';

// ─── migrateSnoozeState ───────────────────────────────────────────────────────

test('migrateSnoozeState: migrates old string[] — each key becomes { legacy: true }', () => {
  const result = migrateSnoozeState(['a:b#1', 'c:d#2']);
  assert.deepEqual(result, {
    'a:b#1': { legacy: true },
    'c:d#2': { legacy: true },
  });
});

test('migrateSnoozeState: passes through an already-migrated Record unchanged', () => {
  const store: SnoozeStore = { 'a:b#1': { until: 1234567890000 } };
  const result = migrateSnoozeState(store);
  assert.deepEqual(result, store);
});

test('migrateSnoozeState: handles empty array', () => {
  assert.deepEqual(migrateSnoozeState([]), {});
});

test('migrateSnoozeState: handles empty object', () => {
  assert.deepEqual(migrateSnoozeState({}), {});
});

test('migrateSnoozeState: treats null/undefined as empty store', () => {
  assert.deepEqual(migrateSnoozeState(null), {});
  assert.deepEqual(migrateSnoozeState(undefined), {});
});

// ─── isSnoozedNow ────────────────────────────────────────────────────────────

const PR_UPDATED_AT = '2024-01-15T10:00:00Z';

test('isSnoozedNow: timed snooze — still within window', () => {
  const now = new Date('2024-01-15T11:00:00Z');
  const until = new Date('2024-01-15T12:00:00Z').getTime();
  assert.equal(isSnoozedNow({ until }, PR_UPDATED_AT, now), true);
});

test('isSnoozedNow: timed snooze — expired (at exact expiry time)', () => {
  const expiry = new Date('2024-01-15T12:00:00Z').getTime();
  const now = new Date(expiry);
  assert.equal(isSnoozedNow({ until: expiry }, PR_UPDATED_AT, now), false);
});

test('isSnoozedNow: timed snooze — expired (past expiry)', () => {
  const expiry = new Date('2024-01-15T12:00:00Z').getTime();
  const now = new Date('2024-01-15T13:00:00Z');
  assert.equal(isSnoozedNow({ until: expiry }, PR_UPDATED_AT, now), false);
});

test('isSnoozedNow: legacy entry — always snoozed (user intent preserved across upgrade)', () => {
  // { legacy: true } entries come from migrateSnoozeState and stay snoozed until
  // stampLegacySnoozes converts them to proper { updatedAt } entries.
  assert.equal(isSnoozedNow({ legacy: true }, PR_UPDATED_AT, new Date()), true);
});

test('isSnoozedNow: "until changed" — PR updatedAt matches stored → snoozed', () => {
  assert.equal(isSnoozedNow({ updatedAt: PR_UPDATED_AT }, PR_UPDATED_AT, new Date()), true);
});

test('isSnoozedNow: "until changed" — PR updatedAt changed → auto-unsnooze', () => {
  assert.equal(isSnoozedNow({ updatedAt: PR_UPDATED_AT }, '2024-01-16T00:00:00Z', new Date()), false);
});

test('isSnoozedNow: entry with no fields — not snoozed', () => {
  assert.equal(isSnoozedNow({}, PR_UPDATED_AT, new Date()), false);
});

// ─── stampLegacySnoozes ──────────────────────────────────────────────────────

test('stampLegacySnoozes: converts a legacy entry to { updatedAt } when PR is on the board', () => {
  const store: SnoozeStore = { 'a:b#1': { legacy: true } };
  const prsByKey = new Map([['a:b#1', { updatedAt: PR_UPDATED_AT }]]);
  const result = stampLegacySnoozes(store, prsByKey);
  assert.deepEqual(result['a:b#1'], { updatedAt: PR_UPDATED_AT });
  assert.ok(!('legacy' in (result['a:b#1'] ?? {})), 'legacy flag should be gone after stamping');
});

test('stampLegacySnoozes: leaves legacy entry untouched when PR is not on the board', () => {
  const store: SnoozeStore = { 'a:b#1': { legacy: true } };
  const result = stampLegacySnoozes(store, new Map());
  assert.deepEqual(result['a:b#1'], { legacy: true });
});

test('stampLegacySnoozes: does not touch non-legacy entries', () => {
  const store: SnoozeStore = { 'a:b#1': { until: 9999 }, 'c:d#2': { updatedAt: 'x' } };
  const result = stampLegacySnoozes(store, new Map([['a:b#1', { updatedAt: 'z' }]]));
  assert.deepEqual(result['a:b#1'], { until: 9999 }); // unchanged
  assert.deepEqual(result['c:d#2'], { updatedAt: 'x' }); // unchanged
});

test('stampLegacySnoozes: stamped entry auto-unsnoozes when updatedAt later changes', () => {
  // After stamping: { updatedAt: ORIGINAL }. If PR is later updated, isSnoozedNow returns false.
  const store: SnoozeStore = { 'a:b#1': { legacy: true } };
  const prsByKey = new Map([['a:b#1', { updatedAt: PR_UPDATED_AT }]]);
  const stamped = stampLegacySnoozes(store, prsByKey);
  const stampedEntry = stamped['a:b#1'];
  assert.ok(stampedEntry !== undefined, 'entry should exist after stamping');
  // Same updatedAt → snoozed
  assert.equal(isSnoozedNow(stampedEntry, PR_UPDATED_AT, new Date()), true);
  // PR later gets a new updatedAt → auto-unsnooze
  assert.equal(isSnoozedNow(stampedEntry, '2024-02-01T00:00:00Z', new Date()), false);
});

test('stampLegacySnoozes: returns the original store object when nothing changed (no-alloc)', () => {
  const store: SnoozeStore = { 'a:b#1': { until: 9999 } };
  const result = stampLegacySnoozes(store, new Map());
  // Same reference — no mutation, no unnecessary new object
  assert.equal(result, store);
});

test('stampLegacySnoozes: does not mutate the input store', () => {
  const store: SnoozeStore = { 'a:b#1': { legacy: true } };
  stampLegacySnoozes(store, new Map([['a:b#1', { updatedAt: 'x' }]]));
  assert.deepEqual(store['a:b#1'], { legacy: true }, 'original store should be unchanged');
});

// ─── snoozeUntil ─────────────────────────────────────────────────────────────

test('snoozeUntil: 1hour — sets until to now + 3600s', () => {
  const now = new Date('2024-01-15T10:00:00Z');
  const result = snoozeUntil({}, 'a:b#1', '1hour', PR_UPDATED_AT, now);
  assert.equal(result['a:b#1']?.until, now.getTime() + 3_600_000);
  assert.equal(result['a:b#1']?.updatedAt, undefined);
});

test('snoozeUntil: tomorrow9am — sets until to 9am local tomorrow', () => {
  const now = new Date();
  const result = snoozeUntil({}, 'a:b#1', 'tomorrow9am', PR_UPDATED_AT, now);
  const until = result['a:b#1']?.until;
  assert.ok(until !== undefined);
  assert.ok(until > now.getTime(), 'should be in the future');
  assert.ok(until < now.getTime() + 48 * 3_600_000, 'should be within 48 hours');
  const d = new Date(until);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

test('snoozeUntil: untilChanged — sets updatedAt, no until', () => {
  const now = new Date('2024-01-15T10:00:00Z');
  const result = snoozeUntil({}, 'a:b#1', 'untilChanged', PR_UPDATED_AT, now);
  assert.equal(result['a:b#1']?.updatedAt, PR_UPDATED_AT);
  assert.equal(result['a:b#1']?.until, undefined);
});

test('snoozeUntil: does not mutate the original store', () => {
  const original: SnoozeStore = {};
  snoozeUntil(original, 'a:b#1', 'untilChanged', PR_UPDATED_AT, new Date());
  assert.deepEqual(original, {});
});

test('snoozeUntil: preserves other entries', () => {
  const original: SnoozeStore = { 'x:y#9': { until: 999 } };
  const result = snoozeUntil(original, 'a:b#1', 'untilChanged', PR_UPDATED_AT, new Date());
  assert.ok(result['x:y#9'] !== undefined);
  assert.ok(result['a:b#1'] !== undefined);
});

// ─── unsnooze ────────────────────────────────────────────────────────────────

test('unsnooze: removes the key from the store', () => {
  const store: SnoozeStore = { 'a:b#1': { until: 9999 }, 'c:d#2': { updatedAt: 'x' } };
  const result = unsnooze(store, 'a:b#1');
  assert.ok(!('a:b#1' in result));
  assert.ok('c:d#2' in result);
});

test('unsnooze: no-op when key is not in store', () => {
  const store: SnoozeStore = { 'c:d#2': { updatedAt: 'x' } };
  const result = unsnooze(store, 'nonexistent');
  assert.deepEqual(result, store);
});

test('unsnooze: does not mutate the original store', () => {
  const original: SnoozeStore = { 'a:b#1': { until: 9999 } };
  unsnooze(original, 'a:b#1');
  assert.ok('a:b#1' in original, 'original should be unchanged');
});

// ─── pruneSnoozed (refreshedRepoKeys-aware) ──────────────────────────────────
// Key format: "host:identity#number"; repo key = "host:identity" (before last '#').

test('pruneSnoozed: removes a PR that is gone from a successfully refreshed repo', () => {
  const store: SnoozeStore = { 'a:r#1': { until: 999 }, 'a:r#2': { updatedAt: 'x' }, 'a:r#3': { until: 111 } };
  // Repo 'a:r' was refreshed; only #2 is still live
  const result = pruneSnoozed(store, new Set(['a:r#2']), new Set(['a:r']));
  assert.deepEqual(Object.keys(result), ['a:r#2']);
});

test('pruneSnoozed: keeps all PRs when all are still live in a refreshed repo', () => {
  const store: SnoozeStore = { 'a:r#1': { until: 1 }, 'a:r#2': { updatedAt: 'x' } };
  const result = pruneSnoozed(store, new Set(['a:r#1', 'a:r#2']), new Set(['a:r']));
  assert.equal(Object.keys(result).length, 2);
});

test('pruneSnoozed: snooze for a PR from a FAILED repo is never pruned', () => {
  // Repo A loaded successfully (in refreshedRepoKeys); repo B failed (not in refreshedRepoKeys).
  const store: SnoozeStore = {
    'github:acme/repoA#1': { updatedAt: 'x' }, // from successful repo
    'github:acme/repoB#2': { legacy: true },    // from failed repo
  };
  const livePrKeys = new Set(['github:acme/repoA#1']); // repoA's PR is live
  const refreshedRepoKeys = new Set(['github:acme/repoA']); // only repoA refreshed
  const result = pruneSnoozed(store, livePrKeys, refreshedRepoKeys);
  assert.ok('github:acme/repoA#1' in result, 'live PR from refreshed repo should be kept');
  assert.ok('github:acme/repoB#2' in result, 'snooze for failed-repo PR must NOT be pruned');
});

test('pruneSnoozed: a gone PR from a refreshed repo IS pruned even if another repo failed', () => {
  const store: SnoozeStore = {
    'github:acme/repoA#99': { updatedAt: 'z' }, // gone from repoA
    'github:acme/repoB#2': { legacy: true },     // from failed repoB
  };
  const livePrKeys = new Set<string>(); // nothing live
  const refreshedRepoKeys = new Set(['github:acme/repoA']); // only repoA refreshed
  const result = pruneSnoozed(store, livePrKeys, refreshedRepoKeys);
  assert.ok(!('github:acme/repoA#99' in result), 'gone PR from refreshed repo should be pruned');
  assert.ok('github:acme/repoB#2' in result, 'failed-repo snooze must survive');
});

test('pruneSnoozed: handles empty store', () => {
  const result = pruneSnoozed({}, new Set(['a:r#1']), new Set(['a:r']));
  assert.deepEqual(result, {});
});

test('pruneSnoozed: returns empty when all refreshed-repo PRs are gone', () => {
  const store: SnoozeStore = { 'a:r#1': { until: 1 }, 'a:r#2': { updatedAt: 'x' } };
  const result = pruneSnoozed(store, new Set(), new Set(['a:r']));
  assert.deepEqual(result, {});
});
