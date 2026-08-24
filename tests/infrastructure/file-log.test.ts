import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLog, OwnerId, StorageLayout } from '../../packages/core/src/index';

/**
 * The product's log, in the store rather than only in the editor's panel.
 *
 * **Why this file exists at all.** Until now the only evidence of a window
 * going wrong was a screenshot the owner happened to take, and the log the
 * editor keeps is somewhere neither of us can name -- the plan's own register
 * records "logs are not on disk" as a claim that turned out false and a path
 * the product never says out loud. With the log in the store, the request is one
 * sentence and it never changes: send me the `.gripterm` folder.
 *
 * Against a real file system, and for the reason the launch trace is: the two
 * properties that matter -- a directory that does not exist yet, and appends
 * that survive a window closing on top of them -- are exactly the ones a fake is
 * free to get right by accident.
 */

const OWNER = OwnerId.fromString('9e1f7f4a-2f6c-4b3d-8a1e-0c5d6e7f8a9b');

/**
 * A directory of this suite's own. Synchronous, so that the variable holding it
 * is assigned in the same tick it is made -- an `await` between the two is a
 * directory `afterEach` may never learn about.
 */
function base(): string {
  return mkdtempSync(join(tmpdir(), 'gripterm-file-log-'));
}

describe('the log the store keeps', () => {
  let dir = '';

  afterEach(async () => {
    const made = dir;
    dir = '';
    if (made !== '') {
      await rm(made, { recursive: true, force: true });
    }
  });

  it('writes into logs/<ownerId>.log, making the directory that is not there yet', async () => {
    dir = base();
    const layout = new StorageLayout(dir);
    const log = new FileLog({ path: layout.logFile(OWNER) });

    log.write({
      at: new Date('2026-08-24T09:15:00.000Z'),
      level: 'info',
      message: 'the window woke up',
      details: undefined,
    });

    const written = await readFile(join(dir, 'logs', `${OWNER.value}.log`), 'utf8');
    expect(written).toBe('2026-08-24T09:15:00.000Z info the window woke up\n');
  });

  it('keeps the level, the moment and the context of every line, in the order they were said', async () => {
    dir = base();
    const log = new FileLog({ path: new StorageLayout(dir).logFile(OWNER) });

    log.write({
      at: new Date('2026-08-24T09:15:00.000Z'),
      level: 'warn',
      message: 'the store was refused',
      details: { reason: 'not absolute' },
    });
    log.write({
      at: new Date('2026-08-24T09:15:01.500Z'),
      level: 'error',
      message: 'a conversation did not come back',
      details: { terminalId: 'abc', reason: 'owner-live' },
    });

    const lines = (await readFile(join(dir, 'logs', `${OWNER.value}.log`), 'utf8')).split('\n');
    expect(lines[0]).toBe('2026-08-24T09:15:00.000Z warn the store was refused {"reason":"not absolute"}');
    expect(lines[1]).toBe(
      '2026-08-24T09:15:01.500Z error a conversation did not come back'
      + ' {"terminalId":"abc","reason":"owner-live"}'
    );
  });

  /*
   * A stack has newlines in it, and a log where one line is sometimes twenty is
   * a log no `grep` and no eye can read. `JSON.stringify` escapes them, so the
   * property to hold is that the escaping is never skipped.
   */
  it('keeps an error whole and still on one line', async () => {
    dir = base();
    const log = new FileLog({ path: new StorageLayout(dir).logFile(OWNER) });

    log.write({
      at: new Date('2026-08-24T09:15:00.000Z'),
      level: 'error',
      message: 'the record could not be read',
      details: { cause: new Error('ENOENT: no such file') },
    });

    const written = await readFile(join(dir, 'logs', `${OWNER.value}.log`), 'utf8');
    expect(written.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(written).toContain('ENOENT: no such file');
    expect(written).toContain('file-log.test.ts');
  });

  /*
   * The one thing a log in somebody's store may not do is grow without end. The
   * previous file is kept rather than removed, because the interesting minute is
   * usually the one before the person noticed.
   */
  it('rolls over at its ceiling and keeps the file it rolled off', async () => {
    dir = base();
    const path = new StorageLayout(dir).logFile(OWNER);
    const log = new FileLog({ path, maxBytes: 200 });

    for (let said = 1; said <= 20; said += 1) {
      log.write({
        at: new Date('2026-08-24T09:15:00.000Z'),
        level: 'info',
        message: `line ${String(said)}`,
        details: undefined,
      });
    }

    const current = await readFile(path, 'utf8');
    const rolled = await readFile(`${path}.1`, 'utf8');
    expect(current.length).toBeLessThanOrEqual(200);
    expect(current).toContain('line 20');
    expect(rolled).toContain('line 1');
    expect(current).not.toContain('line 1\n');
  });

  /*
   * It runs inside the reporting of every other failure, so its own failure must
   * not become the failure a person reads about. It reports the first one to the
   * caller by throwing ONCE -- the relay above it is what decides to let go --
   * and after that it is inert rather than throwing on every line.
   */
  it('gives up rather than throwing on every line once the file cannot be written', async () => {
    dir = base();
    const path = new StorageLayout(dir).logFile(OWNER);
    const log = new FileLog({ path });
    // A directory standing where the file should be, which is what a full disk,
    // a revoked permission or a person's own tooling all look like from here:
    // the append fails and nothing about the next one will be different.
    await mkdir(path, { recursive: true });

    expect(() => {
      log.write({
        at: new Date('2026-08-24T09:15:00.000Z'),
        level: 'info',
        message: 'nowhere to put this',
        details: undefined,
      });
    }).toThrow();
    expect(() => {
      log.write({
        at: new Date('2026-08-24T09:15:01.000Z'),
        level: 'info',
        message: 'nor this',
        details: undefined,
      });
    }).not.toThrow();
  });

  /*
   * The other half of the same rule, and the reason the directory is made in the
   * constructor: a store this build cannot write into at all is discovered by
   * whoever attaches the log, at a moment where refusing is still cheap -- not
   * by the first failure it was supposed to be reporting.
   */
  it('refuses at once when the logs directory cannot be made', async () => {
    dir = base();
    await writeFile(join(dir, 'logs'), 'a file where the directory should be', 'utf8');

    expect(() => new FileLog({ path: new StorageLayout(dir).logFile(OWNER) })).toThrow();
  });
});
