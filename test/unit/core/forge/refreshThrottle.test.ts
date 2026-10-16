import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshThrottle } from '../../../../src/core/forge/refreshThrottle';

test('createRefreshThrottle: shouldRefresh returns true when no previous load', () => {
  const t = createRefreshThrottle(60_000);
  assert.equal(t.shouldRefresh(false, undefined), true);
});

test('createRefreshThrottle: shouldRefresh returns false when in-flight', () => {
  const t = createRefreshThrottle(60_000);
  // Even with no previous load, in-flight blocks a new refresh.
  assert.equal(t.shouldRefresh(true, undefined), false);
});

test('createRefreshThrottle: shouldRefresh returns false when last load was too recent', () => {
  const fakeNow = 1_000_000;
  const t = createRefreshThrottle(60_000, () => fakeNow);
  // last load was 30 s ago, min interval is 60 s
  assert.equal(t.shouldRefresh(false, fakeNow - 30_000), false);
});

test('createRefreshThrottle: shouldRefresh returns true when enough time has elapsed', () => {
  const fakeNow = 1_000_000;
  const t = createRefreshThrottle(60_000, () => fakeNow);
  // last load was exactly 60 s ago
  assert.equal(t.shouldRefresh(false, fakeNow - 60_000), true);
});

test('createRefreshThrottle: shouldRefresh returns true when last load was longer ago than the interval', () => {
  const fakeNow = 1_000_000;
  const t = createRefreshThrottle(60_000, () => fakeNow);
  assert.equal(t.shouldRefresh(false, fakeNow - 120_000), true);
});

test('createRefreshThrottle: in-flight overrides elapsed time — never refresh while one is in flight', () => {
  const fakeNow = 1_000_000;
  const t = createRefreshThrottle(60_000, () => fakeNow);
  // last load was very long ago, but in-flight
  assert.equal(t.shouldRefresh(true, fakeNow - 600_000), false);
});

// Retry-gap throttle pattern used by LaunchpadStatusBar after a failed refresh.
// A 30 s gap is short enough to recover quickly but long enough to avoid hammering the host.
test('retry-gap throttle (30 s): blocks immediately after failure, allows after gap', () => {
  let now = 1_000_000;
  const retry = createRefreshThrottle(30_000, () => now);
  const lastFailedAt = now;

  // immediately after failure — too soon
  assert.equal(retry.shouldRefresh(false, lastFailedAt), false, 'immediately after failure: blocked');

  now += 29_999;
  assert.equal(retry.shouldRefresh(false, lastFailedAt), false, '1 ms before gap: still blocked');

  now += 1; // exactly 30 s elapsed
  assert.equal(retry.shouldRefresh(false, lastFailedAt), true, 'at exactly 30 s: retry allowed');

  now += 60_000; // well past the gap
  assert.equal(retry.shouldRefresh(false, lastFailedAt), true, 'well after gap: retry allowed');

  // in-flight always blocks, even past the gap
  assert.equal(retry.shouldRefresh(true, lastFailedAt), false, 'in-flight: blocked regardless');
});

test('retry-gap throttle: undefined lastFailedAt (first-ever failure) allows immediate retry', () => {
  const retry = createRefreshThrottle(30_000);
  // No prior failure recorded — shouldRefresh with undefined lastLoadedAt returns true
  assert.equal(retry.shouldRefresh(false, undefined), true);
});
