import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveAtomic, writeAtomic } from '../../packages/core/src/index';

/**
 * Against a real file system, because the whole subject is what a real one does
 * under a concurrent reader -- which is precisely what a fake would be free to
 * invent.
 *
 * Four tests below describe WINDOWS, where a `rename` is refused with `EPERM`
 * by two things a reader can hold open (§2.1a) and succeeds silently on POSIX.
 * Which two was measured here on 2026-08-24, one question at a time, because
 * getting it wrong costs a test that proves nothing:
 *
 *   - the TARGET being replaced         -> EPERM
 *   - a file INSIDE the directory moved -> EPERM
 *   - the file being moved itself       -> succeeds
 *
 * They are skipped off Windows rather than written to pass everywhere, because
 * a test that passes on both platforms while only one of them can fail is a
 * test that proves nothing on either.
 */

/* eslint-disable jest/no-standalone-expect -- `windowsOnly` is `it` or `it.skip`, chosen once at load time; the rule cannot see that both are real test blocks and reads every `expect` inside them as standalone. Re-enabled at the foot of the file. */

const onWindows = process.platform === 'win32';
const windowsOnly = onWindows ? it : it.skip;

/**
 * The ladder the two release tests hand the writer, and it is longer than the
 * real one on purpose.
 *
 * Those tests let a reader go WHILE the writer is retrying, so the whole test
 * lives inside the ladder: the release has to land before the last attempt or
 * the writer reports the platform's refusal and the test is red about the
 * machine rather than about the code. Closing a descriptor is file system work
 * like any other, and this suite has been measured taking 1533 ms over a bare
 * `writeFile` on a busy box (2026-08-24). The old ladder gave that release
 * 130 ms; this one gives it 2.2 s, and costs the same 20 ms when nothing is
 * busy, because what ends the wait is the release and not the pause.
 */
const RELEASE_LADDER: readonly number[] = [20, 200, 2000];

/**
 * Waits for what the writer has done, rather than for a number of milliseconds.
 *
 * Both release tests used to close their descriptor on a 25 ms timer, which is
 * not a wait but a bet on how busy the machine is: pushing the same timer to
 * 400 ms -- past the 130 ms ladder those tests then used -- fails the write side
 * every time with the platform's own `EPERM`, which is how the bet was measured
 * rather than argued.
 */
async function until(reached: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await reached()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('the writer never reached its rename');
}

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

    const pending = writeAtomic(target, 'new', { backoffMs: RELEASE_LADDER });
    // The scratch neighbour is the writer's own evidence that it is past the
    // write and into the rename, and it is a STATE rather than a moment: it
    // cannot go away while this descriptor is open, because the rename that
    // would take it away is the one being refused. So there is nothing here to
    // catch in time -- unlike a timer, which has to fire inside a window it
    // knows nothing about.
    await until(async () => (await readdir(base)).some((name) => name.endsWith('.tmp')));
    await handle.close();
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

describe('moving a file out of the way', () => {
  /*
   * Same ladder, one exported name -- but NOT the same hazard, and the
   * difference is measured rather than assumed (2026-08-24, this platform).
   * Moving a file a reader holds open succeeds; it is moving a DIRECTORY that
   * holds a file a reader has open that fails with `EPERM`. Every window in this
   * design reads every other window's files, and a discarded record is moved to
   * `trash/` rather than deleted (M2.7), so this is the operation that carries
   * it -- one record at a time here, one whole terminal directory in
   * `StorageCleaner.sweep`, and only the second of those can meet the refusal.
   */
  it('takes the file with its content, and leaves nothing at the source', async () => {
    const from = join(base, 'record.json');
    const to = join(base, 'trash', 'record.json');
    await writeFile(from, '{"task":"keep me"}', 'utf8');
    await mkdir(join(base, 'trash'));

    await moveAtomic(from, to);

    expect(await readFile(to, 'utf8')).toBe('{"task":"keep me"}');
    expect(await readdir(base)).toStrictEqual(['trash']);
  });

  it('reports the error of the file system itself when there is nothing to move', async () => {
    await expect(
      moveAtomic(join(base, 'gone.json'), join(base, 'trash.json'), { backoffMs: [1, 1] })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /*
   * A DIRECTORY with a file open inside it, and the shape is the whole point.
   *
   * Measured on this platform 2026-08-24, three questions asked separately:
   * renaming a file a reader holds open SUCCEEDS; renaming onto a target a
   * reader holds open fails with `EPERM`; renaming a directory that holds a
   * file a reader has open fails with `EPERM`. The test that used to stand here
   * moved a plain file and called itself a retry test -- pushing its release
   * from 25 ms to 400 ms, three times past its own ladder, still passed it in
   * 5 ms, because the first rename had never failed and there had never been a
   * retry to see.
   *
   * The directory is also the shape the ladder is FOR: `StorageCleaner.sweep`
   * moves `terminals/<id>` into the trash while other windows read the records
   * inside it, which is the one caller of `moveAtomic` that can meet this.
   */
  windowsOnly('gives up with the platform\'s error when the directory is never let go', async () => {
    const from = join(base, 'terminal');
    const to = join(base, 'trash', 'terminal');
    await mkdir(join(base, 'trash'), { recursive: true });
    await mkdir(from);
    await writeFile(join(from, 'record.json'), 'kept', 'utf8');
    const handle = await open(join(from, 'record.json'), 'r');

    try {
      await expect(moveAtomic(from, to, { backoffMs: [1, 1, 1] })).rejects.toMatchObject({
        code: 'EPERM',
      });
      // A failed move is not a lost directory: everything is still where its
      // owner left it, which is what makes the refusal safe to report.
      expect(await readFile(join(from, 'record.json'), 'utf8')).toBe('kept');
      expect(await readdir(join(base, 'trash'))).toStrictEqual([]);
    } finally {
      await handle.close();
    }
  });

  windowsOnly('moves the directory once the reader inside it lets go', async () => {
    const from = join(base, 'terminal');
    const to = join(base, 'trash', 'terminal');
    await mkdir(join(base, 'trash'), { recursive: true });
    await mkdir(from);
    await writeFile(join(from, 'record.json'), 'kept', 'utf8');
    const handle = await open(join(from, 'record.json'), 'r');

    const pending = moveAtomic(from, to, { backoffMs: RELEASE_LADDER });
    // Awaited, because letting go is the event the assertion below needs and
    // the descriptor is not released until this returns. There is no scratch
    // file to watch on this side -- a move makes none -- and none is needed:
    // that a held directory refuses the rename is the test above, pinned there
    // without a clock, so what is left for this one is the recovery.
    await handle.close();
    await pending;

    expect(await readFile(join(to, 'record.json'), 'utf8')).toBe('kept');
    expect(await readdir(base)).toStrictEqual(['trash']);
  });
});

/* eslint-enable jest/no-standalone-expect -- the Windows-only blocks above are the only reason it was off. */
