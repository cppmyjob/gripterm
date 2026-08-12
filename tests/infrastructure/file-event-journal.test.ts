import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  StorageError,
  StorageLayout,
  TerminalId,
  isErrorOfCode,
} from '../../packages/core/src/index';
import type { JournalPolicy } from '../../packages/core/src/index';
import { RecordingLogger } from '../helpers/port-fakes';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * The oracle for the only thing in this store that cannot be recovered later.
 *
 * §10.1а names five places where a version could close the road to the strategy,
 * and four of them cost a schema migration if we get them wrong. This one costs
 * everything: an event consumed and not written is gone, and no later version
 * can go back for it.
 *
 * On a real directory rather than a fake, for the reason M1.6 gave: creating a
 * directory, appending to a file and the shape of an OS refusal are exactly what
 * a fake is free to lie about, and every test built on the lie agrees.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);

/**
 * Noon UTC, so that the LOCAL day is the same date in every time zone this can
 * plausibly run in -- and the expected day is computed with `sv-SE`, which
 * renders `YYYY-MM-DD`, rather than with the formatter under test.
 */
const AT = new Date('2026-08-11T12:00:00.000Z');
const DAY = AT.toLocaleDateString('sv-SE');
const NEXT_DAY_AT = new Date(AT.getTime() + 86_400_000);
const NEXT_DAY = NEXT_DAY_AT.toLocaleDateString('sv-SE');

let root: string;
let logger: RecordingLogger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-journal-'));
  logger = new RecordingLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function journal(policy: Partial<JournalPolicy> = {}, base = root): FileEventJournal {
  return new FileEventJournal({
    layout: new StorageLayout(base),
    logger,
    policy: { ...DEFAULT_JOURNAL_POLICY, ...policy },
  });
}

function eventsDir(terminalId = TERMINAL, base = root): string {
  return join(base, 'terminals', terminalId.value, 'events');
}

function dayFile(day = DAY, terminalId = TERMINAL, base = root): string {
  return join(eventsDir(terminalId, base), `${day}.ndjson`);
}

async function linesOf(day = DAY, terminalId = TERMINAL): Promise<string[]> {
  const text = await readFile(dayFile(day, terminalId), 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

function entry(raw: string, at = AT): Parameters<FileEventJournal['append']>[0] {
  return { terminalId: TERMINAL, receivedAt: at, raw };
}

interface JournalLineOnDisk {
  readonly v: number;
  readonly seq: number;
  readonly at: string;
  readonly terminalId: string;
  readonly raw?: string;
  readonly body?: Record<string, unknown>;
  readonly dropped?: readonly string[];
}

function parseLine(line: string | undefined): JournalLineOnDisk {
  return JSON.parse(line ?? '') as JournalLineOnDisk;
}

/** A file of a known size, so that the size cap can be stated rather than approximated. */
async function fillDay(day: string, bytes: number): Promise<void> {
  await mkdir(eventsDir(), { recursive: true });
  await writeFile(dayFile(day), 'x'.repeat(bytes), 'utf8');
}

describe('the journal writes a history, not a snapshot', () => {
  it('creates the events directory on the first append', async () => {
    await journal().append(entry('{"hook_event_name":"Stop"}'));
    expect(await linesOf()).toHaveLength(1);
  });

  it('appends rather than replaces', async () => {
    const writer = journal({ includeContent: true });
    await writer.append(entry('{"n":1}'));
    await writer.append(entry('{"n":2}'));
    await writer.append(entry('{"n":3}'));

    expect((await linesOf()).map((line) => parseLine(line).raw)).toStrictEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });

  it('gives each terminal its own journal', async () => {
    const other = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
    const writer = journal();
    await writer.append(entry('{"mine":true}'));
    await writer.append({ terminalId: other, receivedAt: AT, raw: '{"theirs":true}' });

    expect(await linesOf()).toHaveLength(1);
    expect(await linesOf(DAY, other)).toHaveLength(1);
  });

  it('names the file for the LOCAL day, because a person asking about yesterday means their own', async () => {
    await journal().append(entry('{"n":1}'));

    expect(await readdir(eventsDir())).toStrictEqual([`${DAY}.ndjson`]);
  });
});

describe('the counter that lets a reader see a hole', () => {
  it('numbers the lines from one, in order', async () => {
    const writer = journal();
    await writer.append(entry('{"n":1}'));
    await writer.append(entry('{"n":2}'));
    await writer.append(entry('{"n":3}'));

    expect((await linesOf()).map((line) => parseLine(line).seq)).toStrictEqual([1, 2, 3]);
  });

  /*
   * The counter is recovered from the FILE and never carried in memory across a
   * restart. A remembered counter would be confidently wrong after every reload
   * of the window -- and a duplicated number is worse than a missing one,
   * because it makes a history look whole when it is not.
   */
  it('continues the numbering of a file another activation started', async () => {
    await journal().append(entry('{"n":1}'));
    await journal().append(entry('{"n":2}'));

    expect((await linesOf()).map((line) => parseLine(line).seq)).toStrictEqual([1, 2]);
  });

  it('starts a new day at one, and leaves the old file alone', async () => {
    const writer = journal();
    await writer.append(entry('{"n":1}', AT));
    await writer.append(entry('{"n":2}', NEXT_DAY_AT));

    expect((await linesOf(DAY)).map((line) => parseLine(line).seq)).toStrictEqual([1]);
    expect((await linesOf(NEXT_DAY)).map((line) => parseLine(line).seq)).toStrictEqual([1]);
  });

  it('does not spend a number on a line that was never written', async () => {
    // A failed append that still moved the counter would manufacture exactly the
    // hole the counter exists to report.
    const writer = journal();
    await writer.append(entry('{"n":1}'));
    await rm(eventsDir(), { recursive: true });
    await writeFile(eventsDir(), 'in the way', 'utf8');
    await expect(writer.append(entry('{"n":2}'))).rejects.toBeInstanceOf(StorageError);

    await rm(eventsDir());
    await writer.append(entry('{"n":3}'));

    expect((await linesOf()).map((line) => parseLine(line).seq)).toStrictEqual([2]);
  });
});

describe('the content filter, which is on by default', () => {
  const BODY = '{"hook_event_name":"UserPromptSubmit","user_input":"the password is hunter2"}';

  it('keeps the texts out of the file', async () => {
    await journal().append(entry(BODY));

    expect(await readFile(dayFile(), 'utf8')).not.toContain('hunter2');
  });

  it('writes the body whole when the person has asked for it', async () => {
    await journal({ includeContent: true }).append(entry(BODY));

    expect(parseLine((await linesOf())[0]).raw).toBe(BODY);
  });
});

describe('the journal keeps a kept body byte for byte', () => {
  const BODIES: readonly (readonly [string, string])[] = [
    ['ordinary JSON', '{"hook_event_name":"Stop","session_id":"abc"}'],
    // The NDJSON invariant. A body holding a newline that reached the file
    // unescaped would split into two lines, and every later reader would see one
    // truncated record and one unparseable one.
    ['a newline inside the body', '{"text":"first\nsecond"}'],
    ['a carriage return', '{"text":"a\r\nb"}'],
    ['non-ASCII', '{"text":"путь к файлу — «Ω»"}'],
    ['a lone quote', '{"text":"he said \\"hi\\""}'],
    // Not every body will be JSON. A journal that could only hold what we can
    // already read would lose exactly the payloads worth keeping: the ones from
    // a version whose contract changed.
    ['not JSON at all', 'this is not json'],
    ['an empty body', ''],
  ];

  it.each(BODIES)('survives %s', async (_label, raw) => {
    await journal({ includeContent: true }).append(entry(raw));

    expect(parseLine((await linesOf())[0]).raw).toBe(raw);
  });

  it.each(BODIES)('%s still leaves exactly one line', async (_label, raw) => {
    await journal({ includeContent: true }).append(entry(raw));
    expect(await linesOf()).toHaveLength(1);
  });
});

describe('retention', () => {
  it('removes a file older than the person asked to keep, and says which', async () => {
    await fillDay('2026-07-01', 10);
    await fillDay('2026-08-01', 10);

    await journal({ retentionDays: 14 }).append(entry('{"n":1}'));

    expect(await readdir(eventsDir())).toStrictEqual([`2026-08-01.ndjson`, `${DAY}.ndjson`]);
    expect(logger.infos.map((line) => line.details?.path)).toStrictEqual([
      dayFile('2026-07-01'),
    ]);
  });

  it('removes the oldest files until the journal is under its size cap', async () => {
    await fillDay('2026-08-09', 80);
    await fillDay('2026-08-10', 80);

    await journal({ maxSizeBytes: 100 }).append(entry('{"n":1}'));

    expect(await readdir(eventsDir())).toStrictEqual(['2026-08-10.ndjson', `${DAY}.ndjson`]);
  });

  it('never trims the day being written, and says so when that is all that is left', async () => {
    // Truncating today would lose today's events to save yesterday's disk. The
    // cap the build cannot honour is reported rather than enforced.
    await fillDay(DAY, 200);

    await journal({ maxSizeBytes: 100 }).append(entry('{"n":1}'));

    // The file is still there AND still holds what it held: a retention that
    // deletes today and lets the next append recreate the file passes a test
    // that only counts names, and loses the day.
    expect(await readFile(dayFile(), 'utf8')).toContain('x'.repeat(200));
    expect(await readdir(eventsDir())).toStrictEqual([`${DAY}.ndjson`]);
    expect(logger.warnings[0]?.message).toContain('over its size cap');
  });

  it('leaves everything alone when both limits are satisfied', async () => {
    await fillDay('2026-08-10', 10);

    await journal().append(entry('{"n":1}'));

    expect(await readdir(eventsDir())).toStrictEqual(['2026-08-10.ndjson', `${DAY}.ndjson`]);
    expect(logger.infos).toStrictEqual([]);
    expect(logger.warnings).toStrictEqual([]);
  });

  it('warns and keeps writing when it cannot prune', async () => {
    // Something shaped like a journal file that is not one. Retention that
    // cannot run is a disk filling up slowly; an append that fails is an event
    // lost now, and the second is the one this class exists to prevent.
    await mkdir(join(eventsDir(), '2026-07-01.ndjson'), { recursive: true });

    await journal().append(entry('{"n":1}'));

    expect(await linesOf()).toHaveLength(1);
    expect(logger.warnings[0]?.message).toContain('could not be pruned');
  });

  it('runs once per day rather than on every append', async () => {
    await fillDay('2026-07-01', 10);
    const writer = journal();

    await writer.append(entry('{"n":1}'));
    await writer.append(entry('{"n":2}'));
    await writer.append(entry('{"n":3}'));

    expect(logger.infos).toHaveLength(1);
  });
});

describe('the journal under concurrency', () => {
  it('does not interleave appends issued at once', async () => {
    const writer = journal({ includeContent: true });
    const count = 40;

    // What this DOES prove: forty appends issued in one tick produce forty
    // well-formed lines, lose none of them, and number them without a repeat.
    //
    // What it does NOT prove, said here rather than implied: that the queue
    // inside the journal is what makes the first part true. A mutation removing
    // it survives -- at this size and at 128 KB per line, checked 2026-08-11 --
    // because `O_APPEND` on Windows landed every write whole anyway. The queue
    // stays because the guarantee is not one the platform makes, and since
    // M2.4a it also serialises the numbering, which IS proven here.
    const padding = 'x'.repeat(4096);
    await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        await writer.append(entry(`{"n":${index},"pad":"${padding}"}`));
      })
    );

    const lines = await linesOf();
    expect(lines).toHaveLength(count);
    expect(lines.map((line) => parseLine(line).seq).sort((a, b) => a - b)).toStrictEqual(
      Array.from({ length: count }, (_unused, index) => index + 1)
    );
  });
});

describe('the journal when the file system refuses', () => {
  it('reports a StorageError naming the path', async () => {
    // A FILE where the terminal directory has to go: `mkdir` cannot proceed.
    await writeFile(join(root, 'terminals'), 'in the way', 'utf8');

    let caught: unknown;
    try {
      await journal().append(entry('{"n":1}'));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StorageError);
    expect(isErrorOfCode(caught, 'STORAGE_ERROR')).toBe(true);
    expect(String((caught as StorageError).details.path)).toContain(`${DAY}.ndjson`);
  });

  it('does not poison the queue for later appends', async () => {
    // A journal that stopped working after one refusal would lose every event
    // from then on, silently -- the exact failure this file exists to prevent.
    const nested = join(root, 'nested');
    const blocked = journal({ includeContent: true }, nested);
    await writeFile(nested, 'in the way', 'utf8');
    await expect(blocked.append(entry('{"n":1}'))).rejects.toBeInstanceOf(StorageError);

    await rm(nested);
    await blocked.append(entry('{"n":2}'));

    expect(await readFile(dayFile(DAY, TERMINAL, nested), 'utf8')).toContain('{\\"n\\":2}');
  });
});
