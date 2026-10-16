import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUpdatedAgo } from '../../../src/utils/formatUpdatedAgo';

const base = new Date('2024-02-04T10:00:00Z');

test('formatUpdatedAgo: under 1 minute → "Updated just now"', () => {
  const then = new Date('2024-02-04T09:59:30Z'); // 30 s ago
  assert.equal(formatUpdatedAgo(then, base), 'Updated just now');
});

test('formatUpdatedAgo: exactly 0 ms ago → "Updated just now"', () => {
  assert.equal(formatUpdatedAgo(base, base), 'Updated just now');
});

test('formatUpdatedAgo: 5 minutes ago', () => {
  const then = new Date(base.getTime() - 5 * 60_000);
  assert.equal(formatUpdatedAgo(then, base), 'Updated 5 min ago');
});

test('formatUpdatedAgo: 59 minutes ago', () => {
  const then = new Date(base.getTime() - 59 * 60_000);
  assert.equal(formatUpdatedAgo(then, base), 'Updated 59 min ago');
});

test('formatUpdatedAgo: exactly 1 hour ago', () => {
  const then = new Date(base.getTime() - 3_600_000);
  assert.equal(formatUpdatedAgo(then, base), 'Updated 1 h ago');
});

test('formatUpdatedAgo: 2 hours ago', () => {
  const then = new Date(base.getTime() - 2 * 3_600_000);
  assert.equal(formatUpdatedAgo(then, base), 'Updated 2 h ago');
});

test('formatUpdatedAgo: 48 hours ago', () => {
  const then = new Date(base.getTime() - 48 * 3_600_000);
  assert.equal(formatUpdatedAgo(then, base), 'Updated 48 h ago');
});
