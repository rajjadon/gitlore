import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchHistoryArgs } from '../../../../src/core/git/GitService';
import { LOG_FORMAT } from '../../../../src/core/git/parsers';

test('buildSearchHistoryArgs: string mode adds -S flag', () => {
  const args = buildSearchHistoryArgs({ query: 'hello world', mode: 'string', maxCount: 10 });
  assert.ok(args.includes('-Shello world'), 'should include -S<query>');
});

test('buildSearchHistoryArgs: regex mode adds -G flag', () => {
  const args = buildSearchHistoryArgs({ query: 'hel+o', mode: 'regex', maxCount: 10 });
  assert.ok(args.includes('-Ghel+o'), 'should include -G<query>');
  assert.ok(!args.some((a) => a.startsWith('-S')), 'should not include -S in regex mode');
});

test('buildSearchHistoryArgs: respects maxCount', () => {
  const args = buildSearchHistoryArgs({ query: 'test', mode: 'string', maxCount: 42 });
  const nIdx = args.indexOf('-n');
  assert.notEqual(nIdx, -1, 'should include -n flag');
  assert.equal(args[nIdx + 1], '42', 'count should match maxCount');
});

test('buildSearchHistoryArgs: no rel → no -- separator', () => {
  const args = buildSearchHistoryArgs({ query: 'foo', mode: 'string', maxCount: 10 });
  assert.ok(!args.includes('--'), 'should not include -- when no filePath given');
});

test('buildSearchHistoryArgs: with rel → -- separator and path appended', () => {
  const args = buildSearchHistoryArgs({ query: 'foo', mode: 'string', maxCount: 10, rel: 'src/bar.ts' });
  const sepIdx = args.indexOf('--');
  assert.notEqual(sepIdx, -1, 'should include -- separator');
  assert.equal(args[sepIdx + 1], 'src/bar.ts', 'path should follow --');
});

test('buildSearchHistoryArgs: uses the standard log format', () => {
  const args = buildSearchHistoryArgs({ query: 'foo', mode: 'string', maxCount: 10 });
  assert.ok(args.some((a) => a.includes(LOG_FORMAT)), 'should use LOG_FORMAT for parsing');
});

test('buildSearchHistoryArgs: string and regex produce different first flag', () => {
  const stringArgs = buildSearchHistoryArgs({ query: 'x', mode: 'string', maxCount: 1 });
  const regexArgs = buildSearchHistoryArgs({ query: 'x', mode: 'regex', maxCount: 1 });
  assert.notEqual(stringArgs[1], regexArgs[1], '-S and -G flags must differ');
});
