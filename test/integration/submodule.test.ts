import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { SUBMODULE_MANIFEST_PATH, type SubmoduleFixtureManifest } from '../fixtures/build-fixture-repo';
import type { GitLoreTestApi } from '../../src/extension';
import { EXTENSION_ID } from './extensionId';

suite('Submodule — blame and file history resolve inside a submodule working tree', () => {
  let manifest: SubmoduleFixtureManifest;
  let api: GitLoreTestApi;

  suiteSetup(async () => {
    // Fail loudly: runTests.ts always builds this fixture (and aborts the whole run if the build
    // throws), so a missing manifest is a broken harness — an early `return` here would turn every
    // test below into a vacuous pass and hide a real submodule regression.
    assert.ok(existsSync(SUBMODULE_MANIFEST_PATH), `submodule fixture manifest missing at ${SUBMODULE_MANIFEST_PATH}`);
    manifest = JSON.parse(readFileSync(SUBMODULE_MANIFEST_PATH, 'utf8')) as SubmoduleFixtureManifest;
    const ext = vscode.extensions.getExtension<GitLoreTestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  test('getRepoRoot resolves to the submodule root, not the parent repo root', async () => {
    const repoRoot = await api.git.getRepoRoot(manifest.submoduleFile);
    // The submodule root should be `parentRoot/sub`, not `parentRoot`.
    assert.ok(repoRoot, 'repo root must be resolvable for a file inside the submodule');
    assert.equal(
      repoRoot,
      manifest.submoduleRoot,
      'getRepoRoot must return the submodule root, not the parent',
    );
  });

  test('blameFile returns blame lines for a tracked file inside the submodule', async () => {
    const blameLines = await api.git.blameFile(manifest.submoduleFile);
    assert.ok(blameLines.length > 0, 'blame must return at least one line for the submodule file');
    // The submodule's only commit should be attributed correctly.
    assert.equal(blameLines[0]?.sha, manifest.submoduleCommitSha);
  });

  test('getFileHistory returns commits for a tracked file inside the submodule', async () => {
    const commits = await api.git.getFileHistory(manifest.submoduleFile, 200);
    assert.ok(commits.length > 0, 'file history must return at least one commit inside the submodule');
    assert.equal(commits[0]?.sha, manifest.submoduleCommitSha, 'most recent commit should match the submodule fixture commit');
  });
});
