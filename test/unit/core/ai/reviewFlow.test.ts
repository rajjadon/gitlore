import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewFlow, type ReviewFlowEvent, type ReviewFlowParams } from '../../../../src/core/ai/reviewFlow';
import type { SummaryModel } from '../../../../src/core/ai/commitSummaryFlow';

async function collect(gen: AsyncGenerator<ReviewFlowEvent>): Promise<ReviewFlowEvent[]> {
  const events: ReviewFlowEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function fakeModel(chunks: string[], failAfter?: number): SummaryModel {
  return {
    async *streamText(): AsyncGenerator<string, void, unknown> {
      for (const [i, chunk] of chunks.entries()) {
        if (failAfter !== undefined && i === failAfter) {
          throw new Error('model error');
        }
        yield chunk;
      }
    },
  };
}

/** A tiny diff that is within the default 8000-char limit. */
const SMALL_DIFF = 'diff --git a/foo.ts b/foo.ts\n+new';

/** A diff that exceeds maxDiffChars when set to 10. */
const BIG_DIFF_FOR_10 = 'diff --git a/foo.ts b/foo.ts\n' + 'x'.repeat(20);

function baseParams(overrides: Partial<ReviewFlowParams> = {}): ReviewFlowParams {
  return {
    enabled: true,
    diff: SMALL_DIFF,
    maxDiffChars: 8000,
    signal: new AbortController().signal,
    selectModel: async () => fakeModel(['summary text']),
    buildSingleCallPrompt: () => 'single prompt',
    buildFilePrompt: (path) => `review ${path}`,
    buildSynthesisPrompt: () => 'synthesis prompt',
    getCachedFileSummary: () => undefined,
    setCachedFileSummary: () => undefined,
    ...overrides,
  };
}

// ── disabled check ───────────────────────────────────────────────────────────

describe('runReviewFlow: disabled', () => {
  test('yields disabled and stops — no model selection', async () => {
    let selectCalls = 0;
    const events = await collect(runReviewFlow(baseParams({
      enabled: false,
      selectModel: async () => { selectCalls++; return fakeModel(['x']); },
    })));
    assert.deepEqual(events, [{ type: 'disabled' }]);
    assert.equal(selectCalls, 0, 'selectModel must not be called when disabled');
  });

  test('disabled with a large diff — no selectModel call (zero model calls)', async () => {
    let selectCalls = 0;
    // diff large enough to trigger multi-file path, but disabled means nothing runs
    const largeDiff = Array.from({ length: 5 }, (_, i) =>
      `diff --git a/f${i}.ts b/f${i}.ts\n` + 'x'.repeat(500),
    ).join('\n');
    const events = await collect(runReviewFlow(baseParams({
      enabled: false,
      diff: largeDiff,
      maxDiffChars: 100,
      selectModel: async () => { selectCalls++; return fakeModel(['x']); },
    })));
    assert.deepEqual(events, [{ type: 'disabled' }]);
    assert.equal(selectCalls, 0);
  });
});

// ── no model ─────────────────────────────────────────────────────────────────

describe('runReviewFlow: no model', () => {
  test('yields noModel when selectModel returns undefined', async () => {
    const events = await collect(runReviewFlow(baseParams({
      selectModel: async () => undefined,
    })));
    assert.deepEqual(events, [{ type: 'noModel' }]);
  });
});

// ── small diff — single-call path ─────────────────────────────────────────────

describe('runReviewFlow: small diff (single call path)', () => {
  test('streams chunks then done with assembled text', async () => {
    const events = await collect(runReviewFlow(baseParams({
      diff: SMALL_DIFF,
      maxDiffChars: 8000,
      selectModel: async () => fakeModel(['Hello ', 'world.']),
    })));
    assert.deepEqual(events, [
      { type: 'chunk', text: 'Hello ' },
      { type: 'chunk', text: 'world.' },
      { type: 'done', text: 'Hello world.' },
    ]);
  });

  test('no progress events on single-call path', async () => {
    const events = await collect(runReviewFlow(baseParams({
      diff: SMALL_DIFF,
      maxDiffChars: 8000,
      selectModel: async () => fakeModel(['text']),
    })));
    assert.ok(!events.some((e) => e.type === 'progress'));
  });

  test('model error on single-call path yields error event', async () => {
    // fakeModel(['x'], 0) throws at the first chunk (index 0), before yielding anything.
    const events = await collect(runReviewFlow(baseParams({
      diff: SMALL_DIFF,
      maxDiffChars: 8000,
      selectModel: async () => fakeModel(['x'], 0),
    })));
    assert.equal(events.length, 1);
    const firstEvent = events[0];
    assert.ok(firstEvent, 'expected an event');
    assert.equal(firstEvent.type, 'error');
  });
});

// ── large diff — map-reduce path ─────────────────────────────────────────────

describe('runReviewFlow: large diff (map-reduce path)', () => {
  /** Build a diff with N files, each large enough to push total over maxDiffChars=50. */
  function makeMultiFileDiff(n: number, charsPerFile = 20): string {
    return Array.from({ length: n }, (_, i) =>
      `diff --git a/file${i}.ts b/file${i}.ts\n` + '+'.repeat(charsPerFile),
    ).join('\n');
  }

  test('emits progress events before each model call', async () => {
    const diff = makeMultiFileDiff(3, 30);
    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => fakeModel(['notes']),
    })));
    const progressEvents = events.filter((e) => e.type === 'progress');
    // 3 files map + synthesis (no progress for synthesis)
    // progress is emitted before each file's model call
    assert.ok(progressEvents.length >= 1, 'should emit at least one progress event');
    for (const e of progressEvents) {
      assert.equal(e.type, 'progress');
      if (e.type === 'progress') {
        assert.match(e.message, /Reviewing file \d+ of \d+…/);
      }
    }
  });

  test('emits chunk events from synthesis step', async () => {
    const diff = makeMultiFileDiff(2, 30);
    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => fakeModel(['synthesis result']),
    })));
    const chunks = events.filter((e) => e.type === 'chunk');
    assert.ok(chunks.length > 0);
  });

  test('emits done with assembled synthesis text', async () => {
    const diff = makeMultiFileDiff(2, 30);
    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => fakeModel(['result']),
    })));
    const done = events.find((e) => e.type === 'done');
    assert.ok(done);
    if (done && done.type === 'done') {
      assert.ok(typeof done.text === 'string');
    }
  });

  test('cap at 12: files beyond cap are listed by name in synthesis prompt, not silently dropped', async () => {
    // 15 files, each large; cap is 12
    const diff = makeMultiFileDiff(15, 5);
    const synthesisPrompts: string[] = [];
    let modelCallCount = 0;

    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 10, // small limit so all 15 files trigger multi-file path
      selectModel: async () => ({
        async *streamText(prompt): AsyncGenerator<string, void, unknown> {
          modelCallCount++;
          synthesisPrompts.push(prompt);
          yield 'ok';
        },
      }),
      buildSynthesisPrompt: (perFileNotes, overflowPaths, _skippedPaths) => {
        return `SYNTHESIS overflow:${overflowPaths.join(',')}`;
      },
    })));

    // 12 map calls + 1 synthesis = 13 total
    assert.equal(modelCallCount, 13, `expected 12 file calls + 1 synthesis, got ${modelCallCount}`);

    // Overflow files (13, 14, 15 → indices 12-14 → file12, file13, file14) listed in synthesis
    const synthesisPrompt = synthesisPrompts[synthesisPrompts.length - 1];
    assert.ok(synthesisPrompt, 'expected a synthesis prompt');
    assert.match(synthesisPrompt, /file12\.ts/);
    assert.match(synthesisPrompt, /file13\.ts/);
    assert.match(synthesisPrompt, /file14\.ts/);
    assert.ok(!events.some((e) => e.type === 'error'), 'no error event for overflow');
  });

  test('model error on one file skips it and notes by name in synthesis — does not kill the review', async () => {
    // 3 files; second file's model call throws
    const diff = makeMultiFileDiff(3, 30);
    let callCount = 0;
    const skippedCapture: string[] = [];

    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => ({
        async *streamText(): AsyncGenerator<string, void, unknown> {
          callCount++;
          // Second call (file index 1) throws
          if (callCount === 2) throw new Error('model exploded');
          yield 'notes';
        },
      }),
      buildSynthesisPrompt: (_perFileNotes, _overflowPaths, skippedPaths) => {
        skippedCapture.push(...skippedPaths);
        return 'synthesis';
      },
    })));

    // Should still reach done (no fatal error)
    assert.ok(events.some((e) => e.type === 'done'), 'should still complete with done event');
    assert.ok(!events.some((e) => e.type === 'error'), 'no top-level error event');
    // The skipped file should be noted in the synthesis prompt
    assert.ok(skippedCapture.includes('file1.ts'), `file1.ts should be in skippedPaths, got: ${skippedCapture}`);
  });

  test('abort mid-map stops further model calls', async () => {
    const diff = makeMultiFileDiff(5, 30);
    const controller = new AbortController();
    let modelCallCount = 0;

    await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      signal: controller.signal,
      selectModel: async () => ({
        async *streamText(): AsyncGenerator<string, void, unknown> {
          modelCallCount++;
          if (modelCallCount === 2) {
            controller.abort();
          }
          yield 'notes';
        },
      }),
    })));

    // After abort on call 2, no further calls should happen (synthesis included)
    assert.ok(modelCallCount < 5, `expected fewer than 5 calls after abort, got ${modelCallCount}`);
  });

  test('cached per-file summaries skip the model call for that file', async () => {
    const diff = makeMultiFileDiff(3, 30);
    let modelCallCount = 0;
    const cache = new Map<string, string>();
    cache.set('file0.ts', 'cached notes for file 0');

    const events = await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => ({
        async *streamText(): AsyncGenerator<string, void, unknown> {
          modelCallCount++;
          yield 'fresh notes';
        },
      }),
      getCachedFileSummary: (path) => cache.get(path),
      setCachedFileSummary: (path, notes) => cache.set(path, notes),
    })));

    // file0 cached → no model call; file1, file2 need calls; + 1 synthesis = 3 total
    assert.equal(modelCallCount, 3, `expected 2 file calls + 1 synthesis = 3, got ${modelCallCount}`);
    assert.ok(events.some((e) => e.type === 'done'));
  });

  test('cached summary is passed to synthesis as a per-file note', async () => {
    const diff = makeMultiFileDiff(2, 30);
    const cache = new Map<string, string>();
    cache.set('file0.ts', 'CACHED NOTES');
    const perFileCapture: Array<{ path: string; notes: string }> = [];

    await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => fakeModel(['fresh']),
      getCachedFileSummary: (path) => cache.get(path),
      setCachedFileSummary: () => undefined,
      buildSynthesisPrompt: (perFileNotes) => {
        perFileCapture.push(...perFileNotes);
        return 'synthesis';
      },
    })));

    const cached = perFileCapture.find((n) => n.path === 'file0.ts');
    assert.ok(cached, 'file0 should appear in perFileNotes');
    if (cached) assert.equal(cached.notes, 'CACHED NOTES');
  });

  test('fresh per-file summary is written to cache after model call', async () => {
    const diff = makeMultiFileDiff(2, 30);
    const cache = new Map<string, string>();

    await collect(runReviewFlow(baseParams({
      diff,
      maxDiffChars: 50,
      selectModel: async () => fakeModel(['generated notes']),
      getCachedFileSummary: (path) => cache.get(path),
      setCachedFileSummary: (path, notes) => cache.set(path, notes),
    })));

    assert.ok(cache.has('file0.ts'), 'file0 should be cached after model call');
    assert.equal(cache.get('file0.ts'), 'generated notes');
  });
});

// ── abort during model selection ─────────────────────────────────────────────

describe('runReviewFlow: abort during model selection', () => {
  test('abort before streaming starts yields no events', async () => {
    const controller = new AbortController();
    let buildSingleCallCount = 0;
    const events = await collect(runReviewFlow(baseParams({
      diff: SMALL_DIFF,
      maxDiffChars: 8000,
      signal: controller.signal,
      selectModel: async () => {
        controller.abort();
        return fakeModel(['x']);
      },
      buildSingleCallPrompt: () => { buildSingleCallCount++; return 'prompt'; },
    })));
    assert.deepEqual(events, []);
    assert.equal(buildSingleCallCount, 0, 'buildSingleCallPrompt must not be called after abort');
  });
});
