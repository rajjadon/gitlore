import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { MANIFEST_PATH, type FixtureManifest } from '../fixtures/build-fixture-repo';
import type { GitLoreTestApi } from '../../src/extension';
import { EXTENSION_ID } from './extensionId';

suite('searchHistory — Find When Text Was Added or Removed', () => {
  let manifest: FixtureManifest;
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  test('finds a known string that was added in the fixture — returns the correct commit', async () => {
    // The fixture's second commit added "line three" to tracked.txt. Searching for
    // "line three" with mode="string" must return at least that commit.
    const repoRoot = await api.git.getRepoRoot(manifest.trackedFile);
    assert.ok(repoRoot, 'repo root must be resolvable for the fixture file');

    const results = await api.git.searchHistory(repoRoot, 'line three', 'string', 200, manifest.trackedFile);

    assert.ok(results.length >= 1, 'must return at least one result');
    const matchingCommit = manifest.commits.find((c) => c.message === 'add line three');
    assert.ok(matchingCommit, 'fixture must have an "add line three" commit');
    assert.ok(
      results.some((r) => r.sha === matchingCommit.sha),
      `expected sha ${matchingCommit.sha} in results`,
    );
  });

  test('returns empty for a string that does not exist in the repo', async () => {
    const repoRoot = await api.git.getRepoRoot(manifest.trackedFile);
    assert.ok(repoRoot);

    const results = await api.git.searchHistory(
      repoRoot, 'THIS_STRING_DEFINITELY_DOES_NOT_EXIST_XYZZY', 'string', 200,
    );
    assert.equal(results.length, 0, 'no results expected for an absent string');
  });

  test('empty query returns an empty array without throwing', async () => {
    const repoRoot = await api.git.getRepoRoot(manifest.trackedFile);
    assert.ok(repoRoot);
    const results = await api.git.searchHistory(repoRoot, '', 'string', 200);
    assert.equal(results.length, 0);
  });

  test('invalid regex throws a GitCommandError', async () => {
    const repoRoot = await api.git.getRepoRoot(manifest.trackedFile);
    assert.ok(repoRoot);
    await assert.rejects(
      async () => api.git.searchHistory(repoRoot, '[invalid(', 'regex', 200),
      (err: unknown) => err instanceof Error && /Invalid regular expression/i.test(err.message),
    );
  });
});
