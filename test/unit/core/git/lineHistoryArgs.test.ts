import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLineHistoryArgs } from '../../../../src/core/git/GitService';

/** Extract the -L value from the args array produced by buildLineHistoryArgs. */
function extractLValue(args: string[]): string {
  const idx = args.indexOf('-L');
  if (idx === -1) throw new Error('-L flag not found in args');
  return args[idx + 1] ?? '';
}

test('buildLineHistoryArgs: single line (0-based → 1-based)', () => {
  const lVal = extractLValue(buildLineHistoryArgs('tracked.txt', 0));
  assert.equal(lVal, '1,1:tracked.txt');
});

test('buildLineHistoryArgs: single line at position 4 (0-based → 5)', () => {
  const lVal = extractLValue(buildLineHistoryArgs('tracked.txt', 4));
  assert.equal(lVal, '5,5:tracked.txt');
});

test('buildLineHistoryArgs: range 4..9 (0-based → 5,10)', () => {
  const lVal = extractLValue(buildLineHistoryArgs('src/foo.ts', 4, 9));
  assert.equal(lVal, '5,10:src/foo.ts');
});

test('buildLineHistoryArgs: reversed range 9..4 normalises to 5,10', () => {
  const forward = extractLValue(buildLineHistoryArgs('tracked.txt', 4, 9));
  const reversed = extractLValue(buildLineHistoryArgs('tracked.txt', 9, 4));
  assert.equal(forward, reversed, 'reversed range should produce the same -L spec');
});

test('buildLineHistoryArgs: negative startLine clamped to 0', () => {
  const lVal = extractLValue(buildLineHistoryArgs('tracked.txt', -5));
  assert.equal(lVal, '1,1:tracked.txt', 'negative start should be clamped to line 1');
});

test('buildLineHistoryArgs: both lines negative → clamped to 1,1', () => {
  const lVal = extractLValue(buildLineHistoryArgs('tracked.txt', -10, -3));
  assert.equal(lVal, '1,1:tracked.txt');
});

test('buildLineHistoryArgs: negative start with positive end clamps correctly', () => {
  // -5 clamped to 0, end stays at 2 → range 0..2 → git 1,3
  const lVal = extractLValue(buildLineHistoryArgs('tracked.txt', -5, 2));
  assert.equal(lVal, '1,3:tracked.txt');
});

test('buildLineHistoryArgs: file path is encoded in the -L spec', () => {
  const args = buildLineHistoryArgs('some/deep/path.ts', 0, 5);
  const lVal = extractLValue(args);
  assert.ok(lVal.endsWith(':some/deep/path.ts'), 'file path must be part of the -L spec');
});

test('buildLineHistoryArgs: single-line call keeps backward compatibility', () => {
  // Existing callers pass (filePath, line) with no endLine.
  const twoArg = buildLineHistoryArgs('tracked.txt', 3);
  const withSameEnd = buildLineHistoryArgs('tracked.txt', 3, 3);
  assert.deepEqual(twoArg, withSameEnd, 'omitting endLine should be identical to passing the same value');
});
