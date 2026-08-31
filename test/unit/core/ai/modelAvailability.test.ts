import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeNoModelReason } from '../../../../src/core/ai/modelAvailability';

test('describeNoModelReason: known VS Code builds get the actionable Copilot Chat hint', () => {
  for (const appName of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Visual Studio Code - Exploration']) {
    assert.equal(
      describeNoModelReason(appName),
      'No language model available. Enable a language model (e.g. GitHub Copilot Chat) to use this feature.',
    );
  }
});

test('describeNoModelReason: unrecognized editors (forks) get a platform-gap message naming the editor', () => {
  const message = describeNoModelReason('Cursor');
  assert.match(message, /^Cursor doesn't expose a language model/);
  assert.match(message, /Cursor's own built-in AI/);
  assert.ok(!message.includes('GitHub Copilot Chat'));
});
