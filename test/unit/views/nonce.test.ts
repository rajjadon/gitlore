import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNonce } from '../../../src/views/nonce';

const ALPHABET = /^[A-Za-z0-9]+$/;

describe('createNonce', () => {
  it('returns a 32-character string', () => {
    assert.strictEqual(createNonce().length, 32);
  });

  it('contains only alphanumeric characters (no Math.random base-64 chars like +/=)', () => {
    for (let i = 0; i < 20; i++) {
      assert.match(createNonce(), ALPHABET);
    }
  });

  it('produces unique values on repeated calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(createNonce());
    }
    // Collision probability with 62^32 space is astronomically low — any collision means something is broken.
    assert.strictEqual(seen.size, 200);
  });
});
