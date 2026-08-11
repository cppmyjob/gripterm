import { execFile } from 'node:child_process';
import { join } from 'node:path';

const EXTENSION_DIR = join(__dirname, '..', '..', 'packages', 'extension');

/** `vsce` starting up is slow, and this asks it exactly once. */
const TIMEOUT_MS = 120_000;

/**
 * What would go into the VSIX, according to the tool that builds it.
 *
 * `vsce ls` applies `.vscodeignore` and prints the file list without packaging
 * anything, so this asks the real rules rather than re-implementing them.
 */
async function packagedFiles(): Promise<readonly string[]> {
  return await new Promise<readonly string[]>((resolve, reject) => {
    execFile(
      'npx',
      ['vsce', 'ls', '--no-dependencies'],
      { cwd: EXTENSION_DIR, shell: true, timeout: TIMEOUT_MS },
      (error: unknown, stdout: string) => {
        if (error !== null) {
          reject(new Error(`vsce ls failed: ${String(error)}`));
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim().replaceAll('\\', '/'))
            .filter((line) => line.length > 0)
        );
      }
    );
  });
}

/**
 * The archive is checked here rather than by review, and for one file in
 * particular.
 *
 * `SessionStart` is the single event the CLI will not deliver over HTTP, so it
 * travels through a script we ship. A packaging rule that excluded that script
 * would cost every terminal that event -- and cost it SILENTLY, because a failed
 * hook is non-blocking: the CLI would carry on, and the only symptom would be a
 * conversation renamed by `/clear` that we never noticed.
 *
 * The integration suite checks that the file exists where activation looks for
 * it. That is the development layout; this is the shipped one, and only this
 * test sees `.vscodeignore` at all.
 */
describe('what goes into the VSIX', () => {
  let files: readonly string[] = [];

  beforeAll(async () => {
    files = await packagedFiles();
  }, TIMEOUT_MS);

  it('carries the hook forwarder', () => {
    expect(files).toContain('assets/gripterm-forwarder.js');
  });

  it('carries the manifest', () => {
    expect(files).toContain('package.json');
  });

  it('leaves the sources out, so the ignore rules are demonstrably in force', () => {
    // Without this the test above would pass on a `.vscodeignore` that had been
    // deleted -- everything would be included, including the forwarder.
    expect(files.filter((file) => file.startsWith('src/'))).toEqual([]);
  });
});
