import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../../packages/core/src/index';

/**
 * Against a real file system, because the whole subject is what a real one does
 * under a concurrent reader -- which is precisely what a fake would be free to
 * invent.
 *
 * Two tests below describe WINDOWS: `rename` over a target that another process
 * holds open for reading fails with `EPERM` there (§2.1a), and succeeds
 * silently on POSIX. They are skipped off Windows rather than written to pass
 * everywhere, because a test that passes on both platforms while only one of
 * them can fail is a test that proves nothing on either.
 */

/* eslint-disable jest/no-standalone-expect -- `windowsOnly` is `it` or `it.skip`, chosen once at load time; the rule cannot see that both are real test blocks and reads every `expect` inside them as standalone. Re-enabled at the foot of the file. */

const onWindows = process.platform === 'win32';
const windowsOnly = onWindows ? it : it.skip;

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-atomic-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('replacing a file without a reader seeing the middle', () => {
  it('writes a file that was not there', async () => {
    const target = join(base, 'record.json');

    await writeAtomic(target, '{"a":1}');

    expect(await readFile(target, 'utf8')).toBe('{"a":1}');
  });

  it('replaces a file that was, and leaves no scratch behind', async () => {
    const target = join(base, 'record.json');
    await writeFile(target, 'old', 'utf8');

    await writeAtomic(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(base)).toStrictEqual(['record.json']);
  });

  it('reports the file system\'s own error and cleans up after itself', async () => {
    // A directory that does not exist: this function is about one file and
    // deliberately does not create its home, so the refusal is the caller's to
    // read.
    const target = join(base, 'missing', 'record.json');

    await expect(writeAtomic(target, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(base)).toStrictEqual([]);
  });

  /*
   * The test M2.2 asks for by name. It has to hold the descriptor open THROUGH
   * the moment of the rename -- a quick `readFile` races past the window and
   * proves nothing.
   */
  windowsOnly('retries while a reader holds the target open, and succeeds once it lets go', async () => {
    const target = join(base, 'record.json');
    await writeFile(target, 'old', 'utf8');
    const handle = await open(target, 'r');

    const pending = writeAtomic(target, 'new', { backoffMs: [10, 30, 90] });
    setTimeout(() => { void handle.close(); }, 25);
    await pending;

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(base)).toStrictEqual(['record.json']);
  });

  windowsOnly('gives up with the platform\'s error when the reader never lets go', async () => {
    const target = join(base, 'record.json');
    await writeFile(target, 'old', 'utf8');
    const handle = await open(target, 'r');

    try {
      await expect(writeAtomic(target, 'new', { backoffMs: [1, 1, 1] })).rejects.toMatchObject({
        code: 'EPERM',
      });
      // The old content is intact: a failed replacement is not a lost file.
      expect(await readFile(target, 'utf8')).toBe('old');
      expect(await readdir(base)).toStrictEqual(['record.json']);
    } finally {
      await handle.close();
    }
  });

  /*
   * One process writing the same path twice at once. The single-writer rule is
   * about two WINDOWS and says nothing about a window racing itself -- a
   * debounced write of the same record does exactly this -- and a scratch name
   * built from the pid alone made the first rename carry off a file the second
   * writer was still using.
   */
  it('lets one process write the same path concurrently without the writers eating each other', async () => {
    const target = join(base, 'record.json');

    await Promise.all([
      writeAtomic(target, 'a'),
      writeAtomic(target, 'b'),
      writeAtomic(target, 'c'),
    ]);

    expect(['a', 'b', 'c']).toContain(await readFile(target, 'utf8'));
    expect(await readdir(base)).toStrictEqual(['record.json']);
  });

  /*
   * A rename that cannot ever succeed, on every platform: the target is a
   * directory with something in it. The ladder runs, the last attempt is made
   * outside the loop, and its error -- the file system's own, not a summary of
   * ours -- is what the caller receives.
   */
  it('runs the ladder out and then reports the platform\'s error, keeping no scratch', async () => {
    const target = join(base, 'occupied');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'child.txt'), 'x', 'utf8');

    await expect(writeAtomic(target, 'new', { backoffMs: [1, 1, 1] })).rejects.toThrow();

    expect(await readdir(base)).toStrictEqual(['occupied']);
    expect(await readdir(target)).toStrictEqual(['child.txt']);
  });
});

/* eslint-enable jest/no-standalone-expect -- the two Windows-only blocks above are the only reason it was off. */
