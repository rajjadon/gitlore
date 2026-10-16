import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceForgeRepos } from '../../../src/providers/workspaceForgeRepos';
import type { GitService } from '../../../src/core/git/GitService';

/** Minimal fake GitService — only the two methods resolveWorkspaceForgeRepos calls. */
function fakeGit(repoRootMap: Record<string, string | null>, remotesMap: Record<string, Array<{ name: string; url: string }>>): GitService {
  return {
    async getRepoRoot(path: string) { return repoRootMap[path] ?? null; },
    async getRemotes(repoRoot: string) { return remotesMap[repoRoot] ?? []; },
  } as unknown as GitService;
}

describe('resolveWorkspaceForgeRepos', () => {
  it('returns empty array when no folders given', async () => {
    const result = await resolveWorkspaceForgeRepos(fakeGit({}, {}), [], []);
    assert.deepStrictEqual(result, []);
  });

  it('skips folders with no git repo root', async () => {
    const git = fakeGit({ '/no-repo': null }, {});
    const result = await resolveWorkspaceForgeRepos(git, ['/no-repo'], []);
    assert.deepStrictEqual(result, []);
  });

  it('skips remotes that are not recognized forge hosts', async () => {
    const git = fakeGit(
      { '/workspace': '/workspace' },
      { '/workspace': [{ name: 'origin', url: 'https://internal.corp.example/repo.git' }] },
    );
    const result = await resolveWorkspaceForgeRepos(git, ['/workspace'], []);
    assert.deepStrictEqual(result, []);
  });

  it('returns a GitHub repo entry for a github.com remote', async () => {
    const git = fakeGit(
      { '/workspace': '/workspace' },
      { '/workspace': [{ name: 'origin', url: 'https://github.com/owner/repo.git' }] },
    );
    const result = await resolveWorkspaceForgeRepos(git, ['/workspace'], []);
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.ok(entry, 'expected one result');
    assert.strictEqual(entry.repo.host, 'github');
    assert.strictEqual(entry.repo.identity, 'owner/repo');
    assert.strictEqual(entry.detected.flavor, 'github');
    assert.strictEqual(entry.repoRoot, '/workspace');
  });

  it('deduplicates repos with the same host+identity across multiple remotes', async () => {
    const git = fakeGit(
      { '/workspace': '/workspace' },
      {
        '/workspace': [
          { name: 'origin', url: 'https://github.com/owner/repo.git' },
          { name: 'upstream', url: 'https://github.com/owner/repo.git' },
        ],
      },
    );
    const result = await resolveWorkspaceForgeRepos(git, ['/workspace'], []);
    assert.strictEqual(result.length, 1);
  });

  it('deduplicates repos with the same identity across multiple workspace folders', async () => {
    const git = fakeGit(
      { '/folderA': '/shared-root', '/folderB': '/shared-root' },
      { '/shared-root': [{ name: 'origin', url: 'https://github.com/owner/repo.git' }] },
    );
    const result = await resolveWorkspaceForgeRepos(git, ['/folderA', '/folderB'], []);
    assert.strictEqual(result.length, 1);
  });

  it('returns multiple repos from different folders pointing at different hosts', async () => {
    const git = fakeGit(
      { '/gh': '/gh', '/gl': '/gl' },
      {
        '/gh': [{ name: 'origin', url: 'https://github.com/owner/repo.git' }],
        '/gl': [{ name: 'origin', url: 'https://gitlab.com/owner/repo.git' }],
      },
    );
    const result = await resolveWorkspaceForgeRepos(git, ['/gh', '/gl'], []);
    assert.strictEqual(result.length, 2);
    const hosts = result.map((r) => r.detected.flavor).sort();
    assert.deepStrictEqual(hosts, ['github', 'gitlab']);
  });
});
