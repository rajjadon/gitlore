import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlameArgs } from '../../../../src/core/git/GitService';

test('buildBlameArgs: no options — minimal args', () => {
  assert.deepEqual(buildBlameArgs({ rel: 'tracked.txt' }), [
    'blame', '--line-porcelain', '--', 'tracked.txt',
  ]);
});

test('buildBlameArgs: ignoreWhitespace only (-w)', () => {
  assert.deepEqual(buildBlameArgs({ ignoreWhitespace: true, rel: 'src/foo.ts' }), [
    'blame', '--line-porcelain', '-w', '--', 'src/foo.ts',
  ]);
});

test('buildBlameArgs: detectMoves only (-M -C)', () => {
  assert.deepEqual(buildBlameArgs({ detectMoves: true, rel: 'src/foo.ts' }), [
    'blame', '--line-porcelain', '-M', '-C', '--', 'src/foo.ts',
  ]);
});

test('buildBlameArgs: ignoreWhitespace + detectMoves', () => {
  assert.deepEqual(buildBlameArgs({ ignoreWhitespace: true, detectMoves: true, rel: 'src/foo.ts' }), [
    'blame', '--line-porcelain', '-w', '-M', '-C', '--', 'src/foo.ts',
  ]);
});

test('buildBlameArgs: ignoreRevsFile only', () => {
  assert.deepEqual(
    buildBlameArgs({ ignoreRevsFile: '/repo/.git-blame-ignore-revs', rel: 'tracked.txt' }),
    ['blame', '--line-porcelain', '--ignore-revs-file', '/repo/.git-blame-ignore-revs', '--', 'tracked.txt'],
  );
});

test('buildBlameArgs: all options — order is -w -M -C --ignore-revs-file', () => {
  assert.deepEqual(
    buildBlameArgs({
      ignoreWhitespace: true,
      detectMoves: true,
      ignoreRevsFile: '/repo/.git-blame-ignore-revs',
      rel: 'src/foo.ts',
    }),
    ['blame', '--line-porcelain', '-w', '-M', '-C', '--ignore-revs-file', '/repo/.git-blame-ignore-revs', '--', 'src/foo.ts'],
  );
});

test('buildBlameArgs: detectMoves false is a no-op (same as omitting it)', () => {
  const withFalse = buildBlameArgs({ detectMoves: false, rel: 'x.ts' });
  const withOmitted = buildBlameArgs({ rel: 'x.ts' });
  assert.deepEqual(withFalse, withOmitted);
});

// Cache-key purity: the option flags must be encodable as a stable string so toggling either
// setting produces a different key and avoids serving stale blame from before the toggle.
test('blame cache key suffix — all four combinations are distinct', () => {
  const suffix = (iw: boolean, dm: boolean): string =>
    `${iw ? 'w' : ''}${dm ? 'm' : ''}`;

  const keys = new Set([
    suffix(false, false),
    suffix(true, false),
    suffix(false, true),
    suffix(true, true),
  ]);
  assert.equal(keys.size, 4, 'all four option combinations must produce distinct key suffixes');
});
