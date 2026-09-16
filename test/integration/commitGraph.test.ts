import * as assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { MANIFEST_PATH, type FixtureManifest, buildSyncFixtureRepo, buildExplorerFixtureRepo } from '../fixtures/build-fixture-repo';
import type { GitLoreTestApi } from '../../src/extension';
import { COMMANDS } from '../../src/constants';
import { resolveRepoContextPath } from '../../src/views/CommitGraph/CommitGraphViewProvider';
import { EXTENSION_ID } from './extensionId';


async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Commit graph webview', () => {
  let manifest: FixtureManifest;
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  async function openGraph(): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('add line three'));
    return api.getCommitGraphHtml() ?? '';
  }

  test('shows every commit newest-first with an avatar node per commit', async () => {
    const html = await openGraph();
    assert.match(html, /add line three/);
    assert.match(html, /Amy Dev/);
    assert.match(html, /first commit/);
    assert.match(html, /Raj Jadon/);
    // Both fixture commits are on one linear branch — exactly two avatar nodes, no merges.
    const imageCount = (html.match(/<image /g) ?? []).length;
    assert.equal(imageCount, 2);
    assert.ok(!html.includes('unsafe-inline'));
  });

  test('renders the toolbar, the column headers (2 text, 4 icon-only), and a scrollable grid', async () => {
    const html = await openGraph();
    assert.match(html, /id="ref-filter"/);
    assert.match(html, /id="search"/);
    assert.match(html, /id="refresh"/);
    assert.match(html, /role="grid"/);
    for (const header of ['Branch / Tag', 'Commit Message']) {
      assert.ok(html.includes(`role="columnheader">${header}<`), `missing column header: ${header}`);
    }
    for (const header of ['Author', 'Changes', 'Commit Date', 'SHA']) {
      assert.ok(
        html.includes(`role="columnheader" title="${header}" aria-label="${header}"><svg`),
        `missing icon-only column header: ${header}`,
      );
    }
    // A page heading inside a 250px-tall panel is pure overhead — the toolbar replaced it.
    assert.ok(!html.includes('<h1>Commit Graph</h1>'));
  });

  test('labels the checked-out branch from --decorate=full, not as an ambiguous ref', async () => {
    const html = await openGraph();
    assert.match(html, /class="ref ref-branch ref-head" title="main \(current\)"/);
  });

  test('shows the per-commit changed-file count from the same log call', async () => {
    const html = await openGraph();
    // Each fixture commit touches exactly tracked.txt.
    assert.match(html, /class="file-count">1</);
  });

  test('pins a Working Changes row for the fixture\'s untracked file', async () => {
    const html = await openGraph();
    assert.match(html, /class="row wip"/);
    assert.match(html, /Working Changes/);
    // untracked.txt is the repo's only uncommitted change, and untracked counts as added.
    assert.match(html, /class="stat-add" title="1 added">\+1</);
  });

  test('lists the repo\'s branches in the ref picker, defaulting to the current branch', async () => {
    const html = await openGraph();
    // The current branch is selected on first load, not "All branches" — the common case is
    // "what have I been doing", not the whole repo's history across every branch.
    assert.match(html, /<option value="main" selected>main \(current\)<\/option>/);
    assert.match(html, /<option value="">All branches<\/option>/);
  });

  test('falls back to the workspace folder when no editor is open, instead of refusing to open', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(vscode.window.activeTextEditor, undefined);

    const contextPath = resolveRepoContextPath();
    assert.ok(contextPath, 'expected a repo context path from the workspace folder');
    assert.ok(await api.git.getRepoRoot(contextPath), 'workspace-folder fallback did not resolve to a git repo');

    // And the command itself stays quiet rather than throwing.
    await vscode.commands.executeCommand(COMMANDS.openGraph);
  });

  test('prefers the active terminal\'s cwd over the workspace folder when no editor is open', async () => {
    const fixture = buildExplorerFixtureRepo();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(vscode.window.activeTextEditor, undefined);

    const terminal = vscode.window.createTerminal({ name: 'gitlore-test-cwd', cwd: fixture.repoRoot });
    try {
      terminal.show(false);
      await waitFor(() => vscode.window.activeTerminal === terminal);

      const contextPath = resolveRepoContextPath();
      assert.ok(contextPath, 'expected a repo context path from the active terminal');
      const repoRoot = await api.git.getRepoRoot(contextPath as string);
      assert.equal(repoRoot, realpathSync(fixture.repoRoot));
    } finally {
      terminal.dispose();
    }
  });

  test('shows pull/push buttons badged with the real ahead/behind counts against the upstream', async () => {
    const fixture = buildSyncFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('ahead commit 1'));

    const html = api.getCommitGraphHtml() ?? '';
    assert.match(html, new RegExp(`id="pull"[^>]*data-tooltip="Pull ${fixture.behind} commits"`));
    assert.match(html, new RegExp(`id="push"[^>]*data-tooltip="Push ${fixture.ahead} commits"`));
    assert.match(html, new RegExp(`id="pull"[\\s\\S]*?class="sync-badge">${fixture.behind}<`));
    assert.match(html, new RegExp(`id="push"[\\s\\S]*?class="sync-badge">${fixture.ahead}<`));
  });

  test('auto-refreshes when HEAD/refs change on disk, without an explicit refresh message', async () => {
    // Regression: the graph previously only reloaded on an explicit "refresh" click or a ref-picker
    // change — a pull/checkout done in a terminal, another tool, or (once shipped) the graph's own
    // pull/push buttons left it showing stale data until the user remembered to click refresh.
    const fixture = buildSyncFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('ahead commit 1'));
    assert.match(api.getCommitGraphHtml() ?? '', /ref-head" title="main \(current\)"/);

    // External change to HEAD/refs — exactly what `git checkout` (from a terminal, another tool,
    // or a real pull) does, without going through GitLore or posting any message to the webview.
    execFileSync('git', ['checkout', '-q', 'pretend-origin-main'], { cwd: fixture.repoRoot });

    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('ref-head" title="pretend-origin-main (current)"'));
  });

  test('offers "Load more" when the cap is hit, and loading more reveals the rest', async () => {
    const config = vscode.workspace.getConfiguration('gitLore');
    await config.update('maxGraphItems', 1, vscode.ConfigurationTarget.Global);
    try {
      const doc = await vscode.workspace.openTextDocument(manifest.trackedFile);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand(COMMANDS.openGraph);
      await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('add line three'));

      const firstHtml = api.getCommitGraphHtml() ?? '';
      assert.match(firstHtml, /id="load-more"/);
      assert.ok(!firstHtml.includes('first commit'), 'expected the cap to hide the older commit');

      await api.loadMoreCommitGraph();
      await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('first commit'));
      assert.match(api.getCommitGraphHtml() ?? '', /add line three/);
    } finally {
      await config.update('maxGraphItems', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

suite('Commit graph context menu actions', () => {
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });


  test('defaults the graph to the current branch, and follows a checkout done outside GitLore', async () => {
    const fixture = buildExplorerFixtureRepo();
    execFileSync('git', ['checkout', '-q', fixture.otherBranch], { cwd: fixture.repoRoot });
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('add feature line'));
    assert.match(api.getCommitGraphHtml() ?? '', new RegExp(`ref-head" title="${fixture.otherBranch} \\(current\\)"`));
  });

  test('places a stash chip on the row of the commit it was based on', async () => {
    const fixture = buildExplorerFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));
    assert.match(api.getCommitGraphHtml() ?? '', new RegExp(`data-stash-index="0"[\\s\\S]*?${fixture.stashMessage}`));
  });

  test('"Checkout" on a commit decorated with another branch switches to that branch', async () => {
    const fixture = buildExplorerFixtureRepo();
    execFileSync('git', ['checkout', '-q', fixture.otherBranch], { cwd: fixture.repoRoot });
    const baseSha = execFileSync('git', ['rev-parse', fixture.currentBranch], { cwd: fixture.repoRoot }).toString().trim();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('add feature line'));

    await api.commitGraphActionForTest('checkout', baseSha);
    assert.equal(await api.git.getCurrentBranch(fixture.trackedFile), fixture.currentBranch);
  });

  test('"Reset Branch to Here" moves HEAD after a QuickPick mode choice and a confirm', async () => {
    const fixture = buildExplorerFixtureRepo();
    const baseSha = execFileSync('git', ['rev-parse', fixture.currentBranch], { cwd: fixture.repoRoot }).toString().trim();
    // Advance main one commit past base, so the reset target actually moves HEAD back.
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'second commit'], { cwd: fixture.repoRoot });
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('second commit'));

    const originalQuickPick = vscode.window.showQuickPick;
    const originalWarning = vscode.window.showWarningMessage;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async () => ({ label: 'Mixed', mode: 'mixed' });
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Reset';
    try {
      await api.commitGraphActionForTest('reset', baseSha);
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    }

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoRoot }).toString().trim();
    assert.equal(head, baseSha);
  });

  test('"Create Branch from Commit" creates a branch at the given sha after an input box', async () => {
    const fixture = buildExplorerFixtureRepo();
    const baseSha = execFileSync('git', ['rev-parse', fixture.currentBranch], { cwd: fixture.repoRoot }).toString().trim();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));

    const originalInputBox = vscode.window.showInputBox;
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async () => 'from-graph';
    try {
      await api.commitGraphActionForTest('createBranch', baseSha);
    } finally {
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox = originalInputBox;
    }

    const branches = await api.git.getBranches(fixture.trackedFile);
    const created = branches.find((b) => b.name === 'from-graph');
    assert.ok(created, 'expected the new branch to exist');
    assert.equal(execFileSync('git', ['rev-parse', 'from-graph'], { cwd: fixture.repoRoot }).toString().trim(), baseSha);
  });

  test('"Tag This Commit" creates a tag at the given sha after an input box', async () => {
    const fixture = buildExplorerFixtureRepo();
    const baseSha = execFileSync('git', ['rev-parse', fixture.currentBranch], { cwd: fixture.repoRoot }).toString().trim();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));

    const originalInputBox = vscode.window.showInputBox;
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async () => 'v2.0.0-graph';
    try {
      await api.commitGraphActionForTest('tag', baseSha);
    } finally {
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox = originalInputBox;
    }

    const tags = await api.git.getTags(fixture.trackedFile);
    assert.ok(tags.some((t) => t.name === 'v2.0.0-graph'));
  });

  test('"Copy SHA" copies the exact sha to the clipboard', async () => {
    const fixture = buildExplorerFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));

    await api.commitGraphActionForTest('copySha', 'deadbeefcafe1234');
    assert.equal(await vscode.env.clipboard.readText(), 'deadbeefcafe1234');
  });

  test('stash chip: Apply keeps the stash and restores the uncommitted change', async () => {
    const fixture = buildExplorerFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));

    await api.commitGraphStashActionForTest('apply', 0);

    assert.ok(readFileSync(fixture.trackedFile, 'utf8').includes('uncommitted change'));
    const stashesAfter = await api.git.getStashes(fixture.trackedFile);
    assert.equal(stashesAfter.length, 1, 'apply must not drop the stash');
  });

  test('stash chip: Delete requires confirmation and then removes the stash', async () => {
    const fixture = buildExplorerFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.openGraph);
    await waitFor(() => (api.getCommitGraphHtml() ?? '').includes('base commit'));

    const original = vscode.window.showWarningMessage;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete';
    try {
      await api.commitGraphStashActionForTest('drop', 0);
    } finally {
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = original;
    }

    const stashesAfter = await api.git.getStashes(fixture.trackedFile);
    assert.equal(stashesAfter.length, 0);
  });
});
