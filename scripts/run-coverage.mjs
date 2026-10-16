#!/usr/bin/env node
// Runs unit tests with Node's built-in coverage (--experimental-test-coverage), scoped to
// src/core/** by running only the test/unit/core/** test files. No new dependencies — tsx
// passes Node flags through, so --experimental-test-coverage reaches the V8 profiler.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

// Only core tests — keeps the coverage report scoped to src/core/** files.
const files = collectTestFiles('test/unit/core');
if (files.length === 0) {
  process.stdout.write('No core unit test files found under test/unit/core.\n');
  process.exit(0);
}

const result = spawnSync('npx', ['tsx', '--test', '--experimental-test-coverage', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
