import { writeFileSync, existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';
import { buildFixtureRepo, MANIFEST_PATH, buildSubmoduleFixtureRepo, SUBMODULE_MANIFEST_PATH } from '../fixtures/build-fixture-repo';

/**
 * `@vscode/test-electron` 2.5.2 hardcodes the macOS app's executable name as `Electron`,
 * but some VS Code builds' Info.plist declares a different `CFBundleExecutable` (e.g. `Code`),
 * so the expected path doesn't exist. Fall back to whatever executable actually sits there.
 */
async function resolveVscodeExecutablePath(): Promise<string> {
  const expected = await downloadAndUnzipVSCode();
  if (existsSync(expected)) {
    return expected;
  }
  const macosDir = dirname(expected);
  const actual = readdirSync(macosDir).find((name) => statSync(join(macosDir, name)).isFile());
  if (!actual) {
    throw new Error(`Could not locate the VS Code executable in ${macosDir}`);
  }
  return join(macosDir, actual);
}

async function main(): Promise<void> {
  const manifest = buildFixtureRepo();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  const submoduleManifest = buildSubmoduleFixtureRepo();
  writeFileSync(SUBMODULE_MANIFEST_PATH, JSON.stringify(submoduleManifest, null, 2));

  // __dirname here is out-test/test/integration; the extension (and its package.json) lives at the project root.
  const extensionDevelopmentPath = join(__dirname, '..', '..', '..');
  const extensionTestsPath = join(__dirname, 'index');
  const vscodeExecutablePath = await resolveVscodeExecutablePath();

  // Fresh user-data-dir per run — otherwise global settings changed by one test run (or one
  // that crashes mid-test, skipping its cleanup) silently leak into the next invocation.
  const userDataDir = mkdtempSync(join(tmpdir(), 'gitlore-vscode-userdata-'));

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      manifest.repoRoot,
      '--disable-extensions',
      '--disable-workspace-trust',
      `--user-data-dir=${userDataDir}`,
    ],
  });
}

main().catch((err) => {
  process.stderr.write(`Integration tests failed to run: ${String(err)}\n`);
  process.exit(1);
});
