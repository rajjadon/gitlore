import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitDiffByFile,
  buildFileReviewPrompt,
  buildReviewSynthesisPrompt,
  buildExplanationSynthesisPrompt,
} from '../../../../src/core/ai/fileReview';
import type { PullRequestSummary, ConversationThread } from '../../../../src/core/forge/types';

function pr(): PullRequestSummary {
  return {
    repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' },
    number: 42,
    title: 'Fix flaky retry logic',
    url: 'https://github.com/acme/widgets/pull/42',
    authorLogin: 'raj',
    isDraft: false,
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-01T10:00:00Z',
    requestedReviewers: [],
    checkStatus: 'passing',
    reviewDecision: 'approved',
    hasConflicts: false,
    reviewedByMe: false,
    headSha: 'abc123',
  };
}

// ── splitDiffByFile ──────────────────────────────────────────────────────────

describe('splitDiffByFile', () => {
  test('empty string returns empty array', () => {
    assert.deepEqual(splitDiffByFile(''), []);
  });

  test('whitespace-only string returns empty array', () => {
    assert.deepEqual(splitDiffByFile('   \n'), []);
  });

  test('single file diff returns one entry with correct path', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'src/foo.ts');
    assert.ok(entry.diff.startsWith('diff --git'));
    assert.equal(entry.isBinary, undefined);
  });

  test('multiple files are split into separate entries', () => {
    const diff = `diff --git a/a.ts b/a.ts
index aaa..bbb 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/b.ts b/b.ts
index ccc..ddd 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-old2
+new2`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 2);
    const first = result[0];
    const second = result[1];
    assert.ok(first, 'expected result[0]');
    assert.ok(second, 'expected result[1]');
    assert.equal(first.path, 'a.ts');
    assert.equal(second.path, 'b.ts');
    // Each entry contains only its own diff content
    assert.ok(first.diff.includes('-old\n+new'));
    assert.ok(!first.diff.includes('b.ts'));
    assert.ok(second.diff.includes('-old2\n+new2'));
  });

  test('binary file is marked with isBinary: true', () => {
    const diff = `diff --git a/image.png b/image.png
index abc..def 100644
Binary files a/image.png and b/image.png differ`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'image.png');
    assert.equal(entry.isBinary, true);
  });

  test('non-binary file does not have isBinary set', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
+new`;
    const result = splitDiffByFile(diff);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.isBinary, undefined);
  });

  test('rename — path is the destination (rename to)', () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index abc..def 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
 unchanged`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'new-name.ts');
  });

  test('diff with no trailing newline parses correctly', () => {
    // No \n at the end — split('\n') gives the right result
    const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+added';
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'x.ts');
    assert.ok(entry.diff.includes('+added'));
  });

  test('path with spaces is extracted correctly', () => {
    const diff = `diff --git a/my file.ts b/my file.ts
--- a/my file.ts
+++ b/my file.ts
@@ -1 +1 @@
+new`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'my file.ts');
  });

  test('many files (15) — returns all 15 entries', () => {
    const files = Array.from({ length: 15 }, (_, i) => `diff --git a/file${i}.ts b/file${i}.ts\n+line${i}`);
    const diff = files.join('\n');
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 15);
    for (let i = 0; i < 15; i++) {
      const entry = result[i];
      assert.ok(entry, `expected result[${i}]`);
      assert.equal(entry.path, `file${i}.ts`);
    }
  });

  test('single huge file — full content returned (no truncation in splitter)', () => {
    const hugeLine = 'x'.repeat(50_000);
    const diff = `diff --git a/big.ts b/big.ts\n+${hugeLine}`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.ok(entry.diff.length > 50_000);
  });

  test('diff with preamble before first diff --git is ignored gracefully', () => {
    const diff = `some preamble\nnot a diff line\ndiff --git a/foo.ts b/foo.ts\n+new`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'foo.ts');
  });

  test('new file (no index) parses path correctly', () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1 @@
+export const x = 1;`;
    const result = splitDiffByFile(diff);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one entry');
    assert.equal(entry.path, 'new-file.ts');
  });
});

// ── buildFileReviewPrompt ────────────────────────────────────────────────────

describe('buildFileReviewPrompt', () => {
  test('includes the file path', () => {
    const prompt = buildFileReviewPrompt('src/foo.ts', '+new line', 8000);
    assert.match(prompt, /src\/foo\.ts/);
  });

  test('includes the diff content', () => {
    const prompt = buildFileReviewPrompt('src/foo.ts', '+new line', 8000);
    assert.match(prompt, /\+new line/);
  });

  test('small diff is not truncated', () => {
    const prompt = buildFileReviewPrompt('src/foo.ts', 'short diff', 8000);
    assert.ok(!prompt.includes('[...truncated]'));
    assert.match(prompt, /short diff/);
  });

  test('large diff is truncated at maxDiffChars with the marker', () => {
    const bigDiff = 'x'.repeat(20);
    const prompt = buildFileReviewPrompt('src/foo.ts', bigDiff, 10);
    assert.match(prompt, /x{10}\[\.\.\.truncated\]/);
    assert.ok(!prompt.includes('x'.repeat(11)));
  });
});

// ── buildReviewSynthesisPrompt ───────────────────────────────────────────────

describe('buildReviewSynthesisPrompt', () => {
  test('includes per-file notes', () => {
    const notes = [{ path: 'src/foo.ts', notes: 'Potential null pointer' }];
    const prompt = buildReviewSynthesisPrompt(pr(), notes, [], [], []);
    assert.match(prompt, /src\/foo\.ts/);
    assert.match(prompt, /Potential null pointer/);
  });

  test('includes overflow paths by name', () => {
    const prompt = buildReviewSynthesisPrompt(pr(), [], ['extra1.ts', 'extra2.ts'], [], []);
    assert.match(prompt, /extra1\.ts/);
    assert.match(prompt, /extra2\.ts/);
  });

  test('includes skipped paths (model error)', () => {
    const prompt = buildReviewSynthesisPrompt(pr(), [], [], ['broken.ts'], []);
    assert.match(prompt, /broken\.ts/);
  });

  test('includes existing conversation threads', () => {
    const threads: ConversationThread[] = [
      { id: 't1', body: 'Is this thread-safe?', authorLogin: 'amy', resolved: false, comments: [] },
    ];
    const prompt = buildReviewSynthesisPrompt(pr(), [], [], [], threads);
    assert.match(prompt, /Is this thread-safe\?/);
    assert.match(prompt, /amy/);
  });

  test('includes PR title', () => {
    const prompt = buildReviewSynthesisPrompt(pr(), [], [], [], []);
    assert.match(prompt, /Fix flaky retry logic/);
  });
});

// ── buildExplanationSynthesisPrompt ─────────────────────────────────────────

describe('buildExplanationSynthesisPrompt', () => {
  test('includes per-file summaries', () => {
    const notes = [{ path: 'src/retry.ts', notes: 'Adds exponential backoff' }];
    const prompt = buildExplanationSynthesisPrompt(pr(), notes, [], []);
    assert.match(prompt, /src\/retry\.ts/);
    assert.match(prompt, /Adds exponential backoff/);
  });

  test('includes overflow paths', () => {
    const prompt = buildExplanationSynthesisPrompt(pr(), [], ['overflow.ts'], []);
    assert.match(prompt, /overflow\.ts/);
  });

  test('includes skipped paths', () => {
    const prompt = buildExplanationSynthesisPrompt(pr(), [], [], ['failed.ts']);
    assert.match(prompt, /failed\.ts/);
  });

  test('includes PR title', () => {
    const prompt = buildExplanationSynthesisPrompt(pr(), [], [], []);
    assert.match(prompt, /Fix flaky retry logic/);
  });
});
