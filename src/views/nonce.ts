import { randomBytes } from 'node:crypto';

/**
 * Generates a 32-character alphanumeric nonce for use in Content Security Policy headers.
 * Uses `crypto.randomBytes` (CSPRNG) instead of Math.random — Math.random is predictable,
 * which would allow a page on the same origin to guess the nonce and inject scripts.
 */
export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  let nonce = '';
  for (const byte of bytes) {
    nonce += alphabet[byte % alphabet.length];
  }
  return nonce;
}
