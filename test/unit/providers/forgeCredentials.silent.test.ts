/**
 * Unit tests for the pure "which credential path for which host" logic that drives
 * resolveForgeTokenSilently. The actual vscode getSession/secrets calls are verified in the
 * integration test that asserts no showInputBox is invoked for an unsigned host.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usesBuiltInSessionForHost } from '../../../src/core/forge/silentCredentialPath';
import type { DetectedForgeHost } from '../../../src/core/forge/hostDetection';

function detected(flavor: DetectedForgeHost['flavor'], displayHost: string): DetectedForgeHost {
  return { flavor, displayHost, apiBaseUrl: 'https://example.com' };
}

describe('usesBuiltInSessionForHost', () => {
  describe('built-in session hosts', () => {
    it('github.com uses built-in session', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('github', 'github.com')), true);
    });

    it('dev.azure.com uses built-in session', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('azureDevOps', 'dev.azure.com')), true);
    });
  });

  describe('PAT hosts (must never call showInputBox silently)', () => {
    it('gitlab.com uses PAT path', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('gitlab', 'gitlab.com')), false);
    });

    it('bitbucket.org uses PAT path', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('bitbucket', 'bitbucket.org')), false);
    });

    it('self-hosted GitHub Enterprise uses PAT path (different displayHost)', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('github', 'github.acme.com')), false);
    });

    it('self-hosted Azure DevOps Server uses PAT path (different displayHost)', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('azureDevOps', 'devops.acme.com')), false);
    });

    it('custom azureDevOps host uses PAT path', () => {
      assert.strictEqual(usesBuiltInSessionForHost(detected('azureDevOps', 'tfs.corp.internal')), false);
    });
  });
});
