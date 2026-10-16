import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { MANIFEST_PATH, type FixtureManifest, buildLineHistoryFixtureRepo } from '../fixtures/build-fixture-repo';
import type { GitLoreTestApi } from '../../src/extension';
import { EXTENSION_ID } from './extensionId';
import { COMMANDS } from '../../src/constants';


function hoverText(hover: vscode.Hover): string {
  return hover.contents
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

suite('Blame hover card', () => {
  let manifest: FixtureManifest;
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  test('shows author, message, gravatar, and diff stat for a tracked line', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0), // "line three", authored by Amy Dev
    );

    assert.ok(hovers && hovers.length > 0, 'expected at least one hover');
    const text = hovers.map(hoverText).join('\n');
    assert.match(text, /Amy Dev/);
    assert.match(text, /add line three/);
    assert.match(text, /gravatar\.com\/avatar\//);
    assert.match(text, /\+1 -0/); // this commit only added "line three"
  });

  test('offers a command link to explain the line with AI, scoped to just that command', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0),
    );

    assert.ok(hovers && hovers.length > 0, 'expected at least one hover');
    const hover = hovers[0];
    assert.ok(hover, 'expected at least one hover');
    const content = hover.contents[0] as vscode.MarkdownString;
    assert.match(content.value, new RegExp(`command:${COMMANDS.explainLine}\\?`));
    const trusted = content.isTrusted as { enabledCommands: string[] } | undefined;
    assert.ok(trusted?.enabledCommands.includes(COMMANDS.explainLine));
  });

  test('shows no hover for an untracked file', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.untrackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(0, 0),
    );

    assert.equal(hovers?.length ?? 0, 0);
  });

  async function withAiConfig<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
    const config = vscode.workspace.getConfiguration('gitLore');
    await config.update('ai.enabled', enabled, vscode.ConfigurationTarget.Global);
    try {
      return await fn();
    } finally {
      await config.update('ai.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  }

  test('gitLore.explainLine with missing arguments shows an info message instead of throwing', async () => {
    await vscode.commands.executeCommand(COMMANDS.explainLine);
  });

  test('gitLore.explainLine with AI disabled shows the settings prompt and leaves the store empty', async () => {
    const commit = manifest.commits[0];
    assert.ok(commit);

    const original = vscode.window.showInformationMessage;
    let calledWith: string | undefined;
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = ((
      message: string,
      ..._rest: unknown[]
    ) => {
      calledWith = message;
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showInformationMessage;

    try {
      await withAiConfig(false, () =>
        Promise.resolve(vscode.commands.executeCommand(COMMANDS.explainLine, manifest.trackedFile, commit.sha, 'line three')),
      );
    } finally {
      vscode.window.showInformationMessage = original;
    }

    assert.equal(calledWith, 'GitLore: AI features are disabled.');
    assert.equal(await api.getLineExplanationStateForTest(manifest.trackedFile, commit.sha, 'line three'), undefined);
  });

  test('gitLore.explainLine with AI enabled and no model registered stores noModel, and the next hover shows it', async () => {
    // The test host never has GitHub Copilot Chat (or any other vscode.lm provider) installed,
    // so this is the one "a real model is involved" branch that's actually deterministic in CI.
    const commit = manifest.commits[0];
    assert.ok(commit);

    await withAiConfig(true, () =>
      Promise.resolve(vscode.commands.executeCommand(COMMANDS.explainLine, manifest.trackedFile, commit.sha, 'line three')),
    );

    assert.deepEqual(await api.getLineExplanationStateForTest(manifest.trackedFile, commit.sha, 'line three'), {
      status: 'noModel',
      message: 'No language model available. Enable a language model (e.g. GitHub Copilot Chat) to use this feature.',
    });

    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0),
    );
    assert.ok(hovers && hovers.length > 0, 'expected at least one hover');
    const text = hovers.map(hoverText).join('\n');
    assert.match(text, /No language model available/);
  });

  test('BlameHoverProvider returns a MarkdownString with supportThemeIcons enabled so codicons render correctly', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0),
    );

    assert.ok(hovers && hovers.length > 0, 'expected at least one hover');
    const content = hovers[0]?.contents[0] as vscode.MarkdownString;
    assert.equal(content.supportThemeIcons, true);
  });

  test('gitLore.explainLine auto-reopens the hover when the cursor is still on the explained line', async () => {
    const commit = manifest.commits[0];
    assert.ok(commit);

    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    const editor = await vscode.window.showTextDocument(doc);
    // Position cursor on line 2 (0-indexed) — "line three" — the line being explained.
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    let showHoverCalled = false;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((
      cmd: string,
      ...args: unknown[]
    ) => {
      if (cmd === 'editor.action.showHover') {
        showHoverCalled = true;
        return Promise.resolve(undefined);
      }
      return originalExecuteCommand(cmd, ...args);
    }) as typeof vscode.commands.executeCommand;

    try {
      await withAiConfig(true, () =>
        Promise.resolve(vscode.commands.executeCommand(COMMANDS.explainLine, manifest.trackedFile, commit.sha, 'line three')),
      );
    } finally {
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }

    assert.ok(showHoverCalled, 'expected editor.action.showHover to be invoked when cursor is still on the explained line');
  });

  test('gitLore.explainLine shows a notification when the cursor has moved off the explained line', async () => {
    const commit = manifest.commits[0];
    assert.ok(commit);

    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    const editor = await vscode.window.showTextDocument(doc);
    // Cursor on line 0 ("line one") — NOT the line being explained ("line three" at line 2).
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    let notificationMessage: string | undefined;
    const originalShowInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = ((
      message: string,
      ..._rest: unknown[]
    ) => {
      notificationMessage = message;
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showInformationMessage;

    let showHoverCalled = false;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((
      cmd: string,
      ...args: unknown[]
    ) => {
      if (cmd === 'editor.action.showHover') {
        showHoverCalled = true;
        return Promise.resolve(undefined);
      }
      return originalExecuteCommand(cmd, ...args);
    }) as typeof vscode.commands.executeCommand;

    try {
      await withAiConfig(true, () =>
        Promise.resolve(vscode.commands.executeCommand(COMMANDS.explainLine, manifest.trackedFile, commit.sha, 'line three')),
      );
    } finally {
      vscode.window.showInformationMessage = originalShowInfo;
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }

    assert.match(notificationMessage ?? '', /hover the line again/);
    assert.ok(!showHoverCalled, 'expected editor.action.showHover NOT to be invoked when cursor has moved');
  });

  test('gitLore.explainLine recovers to an error state instead of leaving the entry stuck at pending when git fails', async () => {
    // A sha absent from the fixture repo: GitService.getCommit/getCommitDiff throw GitCommandError
    // for it (real git, no mocking needed — `git show` on a nonexistent revision fails
    // deterministically). Before the try/catch added around explain()'s body, this propagated out
    // of explain() uncaught, leaving the entry stuck at 'pending' forever — the key was already
    // marked pending before this call, 'pending' renders with no retry link, and explain()'s own
    // guard (`if (existing?.status === 'pending') return;`) silently no-ops any retry attempt too.
    // AI must be enabled for this call to reach the git fetch at all — the disabled gate now runs
    // before any git call (see LineExplanationService.explain()), so with AI off this would never
    // hit the git error this test exercises.
    const badSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    await withAiConfig(true, () =>
      Promise.resolve(vscode.commands.executeCommand(COMMANDS.explainLine, manifest.trackedFile, badSha, 'line three')),
    );

    const state = await api.getLineExplanationStateForTest(manifest.trackedFile, badSha, 'line three');
    assert.equal(state?.status, 'error');
  });

  test('shows Compare / File History / Copy SHA quick actions for a committed line', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0),
    );
    const content = hovers?.[0]?.contents[0] as vscode.MarkdownString;
    assert.match(content.value, new RegExp(`command:${COMMANDS.compareBranches}\\)`));
    assert.match(content.value, new RegExp(`command:${COMMANDS.showFileHistory}\\)`));
    assert.match(content.value, new RegExp(`command:${COMMANDS.copySha}\\?`));
    const trusted = content.isTrusted as { enabledCommands: string[] } | undefined;
    for (const id of [COMMANDS.compareBranches, COMMANDS.showFileHistory, COMMANDS.copySha, COMMANDS.stepLineHistory]) {
      assert.ok(trusted?.enabledCommands.includes(id), `expected ${id} in enabledCommands`);
    }
  });

  test('shows a lone "Older" link with no count on the live card', async () => {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(2, 0),
    );
    const content = hovers?.[0]?.contents[0] as vscode.MarkdownString;
    assert.match(content.value, new RegExp(`command:${COMMANDS.stepLineHistory}\\?`));
    assert.ok(!/\d+ of \d+/.test(content.value));
  });

  suite('line-history revision nav', () => {
    let fixture: ReturnType<typeof buildLineHistoryFixtureRepo>;

    setup(() => {
      fixture = buildLineHistoryFixtureRepo();
    });

    teardown(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function hoverAt(line: number): Promise<vscode.MarkdownString> {
      const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
      await vscode.window.showTextDocument(doc);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        doc.uri,
        new vscode.Position(line, 0),
      );
      const content = hovers?.[0]?.contents[0];
      assert.ok(content, 'expected a hover');
      return content as vscode.MarkdownString;
    }

    test('gitLore.stepLineHistory with missing arguments does not throw', async () => {
      await vscode.commands.executeCommand(COMMANDS.stepLineHistory);
    });

    test('stepping "prev" shows the older commit\'s author and message, with no AI-explain link', async () => {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture.trackedFile));
      editor.selection = new vscode.Selection(fixture.line, 0, fixture.line, 0);

      await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');

      const content = await hoverAt(fixture.line);
      const older = fixture.commits[1];
      assert.ok(older);
      assert.match(content.value, new RegExp(older.author));
      assert.match(content.value, new RegExp(older.message));
      assert.match(content.value, /2 of 3/);
      assert.ok(!content.value.includes('command:gitLore.explainLine'));
      // Three revisions total, one more to go — "prev" is still a link here.
      assert.ok(content.value.includes(`?${encodeURIComponent(JSON.stringify([fixture.trackedFile, fixture.line, 'prev']))}`));
    });

    test('stepping "prev" all the way back reaches the oldest revision, where "prev" has no link', async () => {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture.trackedFile));
      editor.selection = new vscode.Selection(fixture.line, 0, fixture.line, 0);

      await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');
      await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');

      const content = await hoverAt(fixture.line);
      const oldest = fixture.commits[2];
      assert.ok(oldest);
      assert.match(content.value, new RegExp(oldest.author));
      assert.match(content.value, new RegExp(oldest.message));
      assert.match(content.value, /3 of 3/);
      // Already at the oldest revision — "prev" has no link, just the plain glyph.
      assert.ok(!content.value.includes(`?${encodeURIComponent(JSON.stringify([fixture.trackedFile, fixture.line, 'prev']))}`));

      // One more "prev" click should be a no-op (clamped, not out of bounds) — and say so, rather
      // than silently doing nothing, which reads as "this button doesn't work".
      let message: string | undefined;
      const original = vscode.window.showInformationMessage;
      (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = ((
        msg: string,
      ) => {
        message = msg;
        return Promise.resolve(undefined);
      }) as typeof vscode.window.showInformationMessage;
      try {
        await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');
      } finally {
        vscode.window.showInformationMessage = original;
      }
      assert.match(message ?? '', /only revision/);

      const stillOldest = await hoverAt(fixture.line);
      assert.match(stillOldest.value, /3 of 3/);
    });

    test('stepping "prev" then "next" returns to the live card', async () => {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture.trackedFile));
      editor.selection = new vscode.Selection(fixture.line, 0, fixture.line, 0);

      await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');
      await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'next');

      const content = await hoverAt(fixture.line);
      const newest = fixture.commits[0];
      assert.ok(newest);
      assert.match(content.value, new RegExp(newest.author));
      assert.ok(!/\d+ of \d+/.test(content.value));
      assert.match(content.value, new RegExp(`command:${COMMANDS.explainLine}\\?`));
    });

    test('auto-reopens the hover when the cursor is still on the stepped line', async () => {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture.trackedFile));
      editor.selection = new vscode.Selection(fixture.line, 0, fixture.line, 0);

      let showHoverCalled = false;
      const original = vscode.commands.executeCommand;
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((
        cmd: string,
        ...args: unknown[]
      ) => {
        if (cmd === 'editor.action.showHover') {
          showHoverCalled = true;
          return Promise.resolve(undefined);
        }
        return original(cmd, ...args);
      }) as typeof vscode.commands.executeCommand;

      try {
        await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');
      } finally {
        (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = original;
      }

      assert.ok(showHoverCalled, 'expected editor.action.showHover to be invoked');
    });

    test('does not reopen the hover when the cursor has moved to a different line, but says so instead of doing nothing', async () => {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture.trackedFile));
      editor.selection = new vscode.Selection(0, 0, 0, 0);

      let showHoverCalled = false;
      const originalExecute = vscode.commands.executeCommand;
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((
        cmd: string,
        ...args: unknown[]
      ) => {
        if (cmd === 'editor.action.showHover') {
          showHoverCalled = true;
          return Promise.resolve(undefined);
        }
        return originalExecute(cmd, ...args);
      }) as typeof vscode.commands.executeCommand;

      let message: string | undefined;
      const originalShowInfo = vscode.window.showInformationMessage;
      (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = ((
        msg: string,
      ) => {
        message = msg;
        return Promise.resolve(undefined);
      }) as typeof vscode.window.showInformationMessage;

      try {
        await vscode.commands.executeCommand(COMMANDS.stepLineHistory, fixture.trackedFile, fixture.line, 'prev');
      } finally {
        (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecute;
        vscode.window.showInformationMessage = originalShowInfo;
      }

      assert.ok(!showHoverCalled, 'expected editor.action.showHover NOT to be invoked');
      assert.match(message ?? '', /hover the line again/);
    });
  });
});

// ─── gitLore.openPullRequestForCommit — network/prompt isolation ─────────────
//
// These tests prove the privacy contract: the command makes ZERO network calls
// and ZERO credential-prompting UI calls under specified conditions.
//
// Technique: replace globalThis.fetch (which buildForgeClient uses as its
// default fetchImpl — evaluated at call time, not at module load time) and
// vscode.window.showInputBox with counting stubs, restored in finally blocks.
// The fixture repo has no remotes, so even when launchpad is enabled the
// command exits early at "no recognized remote" before any credential lookup.

suite('gitLore.openPullRequestForCommit — network and prompt isolation', () => {
  let manifest: FixtureManifest;

  suiteSetup(async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
  });

  /** Temporarily sets gitLore.launchpad.enabled and restores it in a finally block. */
  async function withLaunchpadConfig<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
    const config = vscode.workspace.getConfiguration('gitLore');
    await config.update('launchpad.enabled', enabled, vscode.ConfigurationTarget.Global);
    try {
      return await fn();
    } finally {
      await config.update('launchpad.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  }

  test('launchpad disabled: zero fetch calls and zero showInputBox calls', async () => {
    const commit = manifest.commits[0];
    assert.ok(commit, 'fixture must have at least one commit');

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCallCount++;
      return Promise.reject(new Error('fetch must not be called when launchpad is disabled'));
    }) as typeof fetch;

    let showInputBoxCallCount = 0;
    const originalShowInputBox = vscode.window.showInputBox;
    (vscode.window as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = (
      (..._args: Parameters<typeof vscode.window.showInputBox>) => {
        showInputBoxCallCount++;
        return Promise.resolve(undefined);
      }
    ) as typeof vscode.window.showInputBox;

    try {
      await withLaunchpadConfig(false, () =>
        Promise.resolve(
          vscode.commands.executeCommand(COMMANDS.openPullRequestForCommit, manifest.trackedFile, commit.sha),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
      vscode.window.showInputBox = originalShowInputBox;
    }

    assert.equal(fetchCallCount, 0, 'fetch must not be called when gitLore.launchpad.enabled is false');
    assert.equal(showInputBoxCallCount, 0, 'showInputBox must not be called when gitLore.launchpad.enabled is false');
  });

  // Positive control: launchpad enabled, but the fixture repo has no remotes,
  // so the command exits at "no recognized remote" before any credential or
  // network call. This is deterministic — the fixture always has no remotes.
  test('launchpad enabled, no remote: zero fetch calls and zero showInputBox calls (silent path)', async () => {
    const commit = manifest.commits[0];
    assert.ok(commit, 'fixture must have at least one commit');

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCallCount++;
      return Promise.reject(new Error('fetch must not be called when there is no recognized remote'));
    }) as typeof fetch;

    let showInputBoxCallCount = 0;
    const originalShowInputBox = vscode.window.showInputBox;
    (vscode.window as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = (
      (..._args: Parameters<typeof vscode.window.showInputBox>) => {
        showInputBoxCallCount++;
        return Promise.resolve(undefined);
      }
    ) as typeof vscode.window.showInputBox;

    // Suppress the expected "No pull request host found" info message so it
    // does not appear as a pop-up in the test host.
    const originalShowInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = (
      (_message: string, ..._rest: unknown[]) => Promise.resolve(undefined)
    ) as typeof vscode.window.showInformationMessage;

    try {
      await withLaunchpadConfig(true, () =>
        Promise.resolve(
          vscode.commands.executeCommand(COMMANDS.openPullRequestForCommit, manifest.trackedFile, commit.sha),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
      vscode.window.showInputBox = originalShowInputBox;
      vscode.window.showInformationMessage = originalShowInfo;
    }

    assert.equal(fetchCallCount, 0, 'fetch must not be called when repo has no recognized remote');
    assert.equal(showInputBoxCallCount, 0, 'showInputBox must not be called on the silent credential path');
  });
});
