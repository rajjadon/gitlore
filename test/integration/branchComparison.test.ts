import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { buildBranchFixtureRepo } from '../fixtures/build-fixture-repo';
import type { GitLoreTestApi } from '../../src/extension';
import { COMMANDS, CONFIG, VIEWS } from '../../src/constants';
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

async function withAiConfig<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const config = vscode.workspace.getConfiguration(CONFIG.section);
  await config.update('ai.enabled', enabled, vscode.ConfigurationTarget.Global);
  try {
    return await fn();
  } finally {
    await config.update('ai.enabled', undefined, vscode.ConfigurationTarget.Global);
  }
}

suite('Branch comparison webview', () => {
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  async function openComparison(): Promise<string> {
    const fixture = buildBranchFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);

    // Passing (base, compare) explicitly skips the default-ref resolution.
    await vscode.commands.executeCommand(COMMANDS.compareBranches, fixture.baseBranch, fixture.featureBranch);
    await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('add feature line'));
    return api.getBranchComparisonHtml() ?? '';
  }

  // Must run before any other test in this suite reveals the Branch Comparison view — VS Code only
  // calls resolveWebviewView() once per view's lifetime, so this is the one chance to observe its
  // very first reveal. No earlier-alphabetical suite (only blame.test.ts sorts before this file)
  // touches Branch Comparison, so this ordering is safe.
  test('stays closed (shows a placeholder) until Compare Branches is explicitly run, instead of auto-loading a default comparison', async () => {
    await vscode.commands.executeCommand(`${VIEWS.branchComparison}.focus`);
    await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('Compare two branches'));
    const html = api.getBranchComparisonHtml() ?? '';
    assert.match(html, /class="empty">Compare two branches to see their diff here\.<\/p>/);
  });

  test('an explicit show(base, compare) resolves to exactly the requested pairing', async () => {
    const fixture = buildBranchFixtureRepo();
    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);

    await vscode.commands.executeCommand(COMMANDS.compareBranches, fixture.baseBranch, fixture.featureBranch);
    await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('add feature line'));

    const html = api.getBranchComparisonHtml() ?? '';
    assert.match(html, /<option value="main" selected>main<\/option>/);
    assert.match(html, /<option value="feature-x" selected>feature-x<\/option>/);
    assert.match(html, /class="ref-pick ref-base">[\s\S]*?value="main" selected/);
    assert.match(html, /class="ref-pick ref-compare">[\s\S]*?value="feature-x" selected/);
  });

  test('shows ahead commits, files changed, and diff between two branches', async () => {
    const html = await openComparison();
    assert.match(html, /add feature line/);
    assert.match(html, /Amy Dev/);
    assert.match(html, /tracked\.txt/);
    assert.match(html, /class="dc diff-add">\+feature line</);
    assert.ok(!html.includes('unsafe-inline'));
  });

  test('renders the ref bar, the swap control, and the Ahead/Behind/All Files tabs with counts', async () => {
    const html = await openComparison();
    assert.match(html, /class="ref-pick ref-base">/);
    assert.match(html, /class="ref-pick ref-compare">/);
    assert.match(html, /id="swap"/);
    // The fixture's feature branch is one commit ahead of main and nothing behind.
    assert.match(html, /data-pane="ahead">Ahead<span class="badge badge-ahead">1<\/span>/);
    assert.match(html, /data-pane="behind">Behind<span class="badge badge-behind">0<\/span>/);
    assert.match(html, /data-pane="files">All Files<span class="badge badge-files">1<\/span>/);
    // Something is ahead, so that's the pane it opens on.
    assert.match(html, /id="tab-ahead"[^>]*aria-selected="true"/);
  });

  test('states the good outcome in the empty Behind pane rather than "no results"', async () => {
    const html = await openComparison();
    assert.match(html, /is up to date with main<\/span>/);
  });

  test('both refs appear in the pickers so the comparison can be retargeted in place', async () => {
    const html = await openComparison();
    assert.match(html, /<option value="main" selected>main<\/option>/);
    assert.match(html, /<option value="feature-x" selected>feature-x<\/option>/);
  });

  test('shows an info message instead of a broken flow with no active editor context', async () => {
    // Falls back to the workspace folder, which is the single-branch fixture repo — there is
    // nothing to compare it against, so the command reports that and stops.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand(COMMANDS.compareBranches);
  });

  test('shows an Open all changes button alongside the per-file diff actions', async () => {
    const html = await openComparison();
    assert.match(html, /id="open-all"/);
  });

  test('no Create PR button when the repo has no remote configured', async () => {
    const html = await openComparison();
    assert.ok(!html.includes('id="create-pr"'));
  });

  test('shows a Create PR button pointed at the compare URL when the repo has a recognized-host remote', async () => {
    const fixture = buildBranchFixtureRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: fixture.repoRoot });

    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.compareBranches, fixture.baseBranch, fixture.featureBranch);
    await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('add feature line'));

    const html = api.getBranchComparisonHtml() ?? '';
    assert.match(html, /id="create-pr"/);
    assert.match(html, /Create a PR on GitHub/);
    assert.match(html, /type: 'createPr'/);
  });

  test('creating a pull request calls the host\'s API when gitLore.launchpad.enabled is on', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    await config.update('launchpad.enabled', true, vscode.ConfigurationTarget.Global);
    try {
      const fixture = buildBranchFixtureRepo();
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/created-widgets.git'], { cwd: fixture.repoRoot });

      const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand(COMMANDS.compareBranches, fixture.baseBranch, fixture.featureBranch);
      await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('add feature line'));

      let capturedBody: string | undefined;
      api.branchComparisonViewProvider.setFetchImplForTest((async (url: string, init?: RequestInit) => {
        if (url.endsWith('/repos/acme/created-widgets/pulls') && init?.method === 'POST') {
          capturedBody = init.body as string;
          return new Response(
            JSON.stringify({
              number: 99,
              title: 'Add feature line',
              html_url: 'https://github.com/acme/created-widgets/pull/99',
              user: { login: 'raj' },
              draft: false,
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
              head: { sha: 'abc123' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unmocked request in test: ${url}`);
      }) as unknown as typeof fetch);

      const originalGetSession = vscode.authentication.getSession;
      (vscode.authentication as { getSession: typeof vscode.authentication.getSession }).getSession = (async () => ({
        id: 'fake-session',
        accessToken: 'fake-github-token',
        account: { id: 'fake-account', label: 'raj' },
        scopes: [],
      })) as typeof vscode.authentication.getSession;
      try {
        await api.branchComparisonViewProvider.createPullRequestForTest('Add feature line', false);
      } finally {
        vscode.authentication.getSession = originalGetSession;
      }

      assert.ok(capturedBody, 'expected the create-PR endpoint to be called');
      assert.equal(capturedBody, JSON.stringify({ title: 'Add feature line', head: 'feature-x', base: 'main', draft: false }));
    } finally {
      await config.update('launchpad.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('creating a pull request is a no-op when gitLore.launchpad.enabled is off — Create PR shares that toggle\'s "only thing that calls out to a remote host" contract', async () => {
    const fixture = buildBranchFixtureRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/disabled-widgets.git'], { cwd: fixture.repoRoot });

    const doc = await vscode.workspace.openTextDocument(fixture.trackedFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand(COMMANDS.compareBranches, fixture.baseBranch, fixture.featureBranch);
    await waitFor(() => (api.getBranchComparisonHtml() ?? '').includes('add feature line'));

    let calledNetwork = false;
    api.branchComparisonViewProvider.setFetchImplForTest((async () => {
      calledNetwork = true;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    await api.branchComparisonViewProvider.createPullRequestForTest('Add feature line', false);
    assert.ok(!calledNetwork, 'expected no network call when Launchpad is disabled');
  });

  test('summarizeComparison: with AI disabled, resets the summary section instead of calling a model', async () => {
    await openComparison();
    await withAiConfig(false, () => api.summarizeBranchComparison());
    assert.deepEqual(api.getBranchComparisonAiSummaryMessagesForTest(), [{ type: 'aiSummaryReset' }]);
  });

  test('summarizeComparison: with AI enabled and no model registered, shows the no-model hint', async () => {
    await openComparison();
    await withAiConfig(true, () => api.summarizeBranchComparison());
    assert.deepEqual(api.getBranchComparisonAiSummaryMessagesForTest(), [{ type: 'aiSummaryNoModel' }]);
  });
});
