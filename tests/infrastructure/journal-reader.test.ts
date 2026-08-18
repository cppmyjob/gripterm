import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  JOURNAL_TAIL_WINDOW_BYTES,
  StorageLayout,
  TerminalId,
  lastSequenceIn,
  readJournal,
  readJournalTail,
} from '../../packages/core/src/index';
import { RecordingLogger } from '../helpers/port-fakes';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * The read side of `seq`, and the reason `seq` exists at all.
 *
 * An append-only file cannot tell you what it never received. A projector
 * rebuilding state from a journal with a hole in it has to know it is working
 * from an incomplete record rather than quietly producing a plausible answer --
 * so the gap is a value the reader returns, not a warning in a log somebody may
 * or may not read.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const AT = new Date('2026-08-11T12:00:00.000Z');

let root: string;
let layout: StorageLayout;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-journal-read-'));
  layout = new StorageLayout(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function eventsDir(): string {
  return join(root, 'terminals', TERMINAL_UUID, 'events');
}

/** Writes a day file directly, so that a history can be stated rather than produced. */
async function writeDay(day: string, ...lines: readonly unknown[]): Promise<void> {
  await mkdir(eventsDir(), { recursive: true });
  const text = lines.map((item) => JSON.stringify(item)).join('\n');
  await writeFile(join(eventsDir(), `${day}.ndjson`), `${text}\n`, 'utf8');
}

function line(seq: number | null, n: number): Record<string, unknown> {
  const body = { v: 2, at: AT.toISOString(), terminalId: TERMINAL_UUID, raw: `{"n":${n}}` };
  return seq === null ? body : { ...body, seq };
}

describe('reading a terminal history', () => {
  it('says nothing at all for a terminal that has never been written to', async () => {
    expect(await readJournal(layout, TERMINAL)).toStrictEqual({
      lines: [],
      gaps: [],
      unreadableLines: 0,
      unreadableFiles: [],
    });
  });

  it('reads the days oldest first, whatever order the file system lists them in', async () => {
    await writeDay('2026-08-10', line(1, 1), line(2, 2));
    await writeDay('2026-08-09', line(1, 0));

    const read = await readJournal(layout, TERMINAL);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
  });

  /*
   * M1 wrote one flat `events.ndjson` per terminal, and there are such files on
   * this machine with real history in them. Nothing writes them any more; the
   * reader takes them as the oldest day, because a journal is the one thing no
   * later version can go back for (§10.1а).
   */
  it('reads the flat file M1 left, as the oldest day, and does not fault its missing counter', async () => {
    await mkdir(join(root, 'terminals', TERMINAL_UUID), { recursive: true });
    await writeFile(
      join(root, 'terminals', TERMINAL_UUID, 'events.ndjson'),
      `${JSON.stringify(line(null, 100))}\n`,
      'utf8'
    );
    await writeDay('2026-08-10', line(1, 1));

    const read = await readJournal(layout, TERMINAL);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 100 }, { n: 1 }]);
    expect(read.gaps).toStrictEqual([]);
  });
});

describe('the gap in a numbering', () => {
  it('finds a line that is not there', async () => {
    await writeDay('2026-08-10', line(1, 1), line(2, 2), line(5, 5));

    expect((await readJournal(layout, TERMINAL)).gaps).toStrictEqual([{ expected: 3, found: 5 }]);
  });

  it('finds a gap that spans two days, because the numbering does', async () => {
    await writeDay('2026-08-10', line(1, 1));
    await writeDay('2026-08-11', line(7, 7));

    expect((await readJournal(layout, TERMINAL)).gaps).toStrictEqual([{ expected: 2, found: 7 }]);
  });

  it('reports a numbering that restarted through the same door', async () => {
    // Not a smaller kind of gap but a different event -- two writers, or a file
    // whose tail could not be read. The consequence for a reader is the same:
    // what it holds is not one uninterrupted sequence.
    await writeDay('2026-08-10', line(5, 5), line(1, 1));

    expect((await readJournal(layout, TERMINAL)).gaps).toStrictEqual([{ expected: 6, found: 1 }]);
  });

  it('does not call a history that merely starts late a gap', async () => {
    // Retention deletes whole files by design, so the oldest surviving line
    // usually is not number one. A reader that called that a hole would report
    // one every day, and a report that always fires is not read.
    await writeDay('2026-08-10', line(48, 48), line(49, 49));

    expect((await readJournal(layout, TERMINAL)).gaps).toStrictEqual([]);
  });

  it('steps over unnumbered lines rather than counting them as holes', async () => {
    await writeDay('2026-08-10', line(1, 1), line(null, 2), line(2, 3));

    expect((await readJournal(layout, TERMINAL)).gaps).toStrictEqual([]);
  });
});

describe('a history with damage in it', () => {
  it('steps over a day that was opened and never written to', async () => {
    await mkdir(eventsDir(), { recursive: true });
    await writeFile(join(eventsDir(), '2026-08-11.ndjson'), '', 'utf8');
    await writeDay('2026-08-10', line(1, 1));

    const read = await readJournalTail(layout, TERMINAL, 20);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 1 }]);
    expect(read.unreadableFiles).toStrictEqual([]);
  });

  it('counts a torn line and returns its neighbours', async () => {
    await mkdir(eventsDir(), { recursive: true });
    await writeFile(
      join(eventsDir(), '2026-08-10.ndjson'),
      `${JSON.stringify(line(1, 1))}\n{"v":2,"seq":2,"at":"2026\n${JSON.stringify(line(3, 3))}\n`,
      'utf8'
    );

    const read = await readJournal(layout, TERMINAL);

    expect(read.lines).toHaveLength(2);
    expect(read.unreadableLines).toBe(1);
    // The hole the torn line left is reported as well: the two questions -- what
    // could not be read, and what is missing -- have different answers here.
    expect(read.gaps).toStrictEqual([{ expected: 2, found: 3 }]);
  });

  it('names a file it could not read and reads the rest', async () => {
    await writeDay('2026-08-10', line(1, 1));
    await mkdir(join(eventsDir(), '2026-08-11.ndjson'), { recursive: true });

    const read = await readJournal(layout, TERMINAL);

    expect(read.lines).toHaveLength(1);
    expect(read.unreadableFiles).toStrictEqual([join(eventsDir(), '2026-08-11.ndjson')]);
  });

  it('ignores what is not a journal file at all', async () => {
    await writeDay('2026-08-10', line(1, 1));
    await writeFile(join(eventsDir(), 'notes.txt'), 'not ours', 'utf8');
    await writeFile(join(eventsDir(), '2026-08-10.ndjson.bak'), 'not ours either', 'utf8');

    const read = await readJournal(layout, TERMINAL);

    expect(read.lines).toHaveLength(1);
    expect(read.unreadableFiles).toStrictEqual([]);
  });
});

describe('the tail of a history, which is what a panel shows', () => {
  it('says nothing at all for a terminal that has never been written to', async () => {
    expect(await readJournalTail(layout, TERMINAL, 20)).toStrictEqual({
      lines: [],
      gaps: [],
      unreadableLines: 0,
      unreadableFiles: [],
      bytesRead: 0,
    });
  });

  it('keeps the newest lines and hands them over oldest first', async () => {
    await writeDay('2026-08-10', line(1, 1), line(2, 2), line(3, 3), line(4, 4));

    const read = await readJournalTail(layout, TERMINAL, 2);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 3 }, { n: 4 }]);
  });

  it('walks back into the day before when the newest one is short', async () => {
    await writeDay('2026-08-10', line(1, 1), line(2, 2));
    await writeDay('2026-08-11', line(1, 3));

    const read = await readJournalTail(layout, TERMINAL, 3);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('reads the flat file M1 left, when the days do not fill the tail', async () => {
    await mkdir(join(root, 'terminals', TERMINAL_UUID), { recursive: true });
    await writeFile(
      join(root, 'terminals', TERMINAL_UUID, 'events.ndjson'),
      `${JSON.stringify(line(null, 100))}
`,
      'utf8'
    );
    await writeDay('2026-08-10', line(1, 1));

    const read = await readJournalTail(layout, TERMINAL, 5);

    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([{ n: 100 }, { n: 1 }]);
    expect(read.gaps).toStrictEqual([]);
  });

  /*
   * The difference from `readJournal`, and the reason this function exists at
   * all rather than a `slice` of that one. The writer starts every day's file
   * at one (`file-event-journal.ts`, "starts a new day at one"), so a reader
   * that compared the last line of Monday with the first line of Tuesday finds
   * a hole in every healthy journal older than a day -- and a panel that
   * reported it would be crying wolf daily.
   */
  it('does not call the turn of the day a hole in the history', async () => {
    await writeDay('2026-08-10', line(1, 1), line(2, 2));
    await writeDay('2026-08-11', line(1, 3), line(2, 4));

    expect((await readJournalTail(layout, TERMINAL, 20)).gaps).toStrictEqual([]);
  });

  it('still finds a hole inside one day', async () => {
    await writeDay('2026-08-10', line(1, 1), line(4, 4));

    expect((await readJournalTail(layout, TERMINAL, 20)).gaps).toStrictEqual([
      { expected: 2, found: 4 },
    ]);
  });

  it('does not report a hole among lines it did not keep', async () => {
    await writeDay('2026-08-10', line(1, 1), line(5, 5), line(6, 6));

    expect((await readJournalTail(layout, TERMINAL, 2)).gaps).toStrictEqual([]);
  });

  it('counts a torn line and returns its neighbours', async () => {
    await mkdir(eventsDir(), { recursive: true });
    await writeFile(
      join(eventsDir(), '2026-08-10.ndjson'),
      `${JSON.stringify(line(1, 1))}
{"v":2,"seq":2,"at":"2026
${JSON.stringify(line(3, 3))}
`,
      'utf8'
    );

    const read = await readJournalTail(layout, TERMINAL, 20);

    expect(read.lines).toHaveLength(2);
    expect(read.unreadableLines).toBe(1);
    expect(read.gaps).toStrictEqual([{ expected: 2, found: 3 }]);
  });

  it('names a file it could not read and reads the rest', async () => {
    await writeDay('2026-08-10', line(1, 1));
    await mkdir(join(eventsDir(), '2026-08-11.ndjson'), { recursive: true });

    const read = await readJournalTail(layout, TERMINAL, 20);

    expect(read.lines).toHaveLength(1);
    expect(read.unreadableFiles).toStrictEqual([join(eventsDir(), '2026-08-11.ndjson')]);
  });

  /*
   * The whole point of the function: this runs again every time an event
   * reaches the shown terminal, so what it costs must not grow with the
   * history. `bytesRead` is that cost, returned rather than described, because
   * a promise about work done is worth exactly what measures it.
   */
  it('reads a bounded window of a file however long the file is', async () => {
    const fat = Array.from({ length: 20_000 }, (_, index) => line(index + 1, index + 1));
    await writeDay('2026-08-10', ...fat);

    const read = await readJournalTail(layout, TERMINAL, 3);

    expect(read.bytesRead).toBeLessThanOrEqual(JOURNAL_TAIL_WINDOW_BYTES);
    expect(read.lines.map((entry) => entry.payload)).toStrictEqual([
      { n: 19_998 },
      { n: 19_999 },
      { n: 20_000 },
    ]);
  });

  it('drops the half line the window starts in the middle of', async () => {
    // The first line of a window that did not start at the beginning of the
    // file is a fragment, and a fragment decoded is either an unreadable line
    // in a healthy journal or, worse, a plausible one.
    const fat = Array.from({ length: 20_000 }, (_, index) => line(index + 1, index + 1));
    await writeDay('2026-08-10', ...fat);

    expect((await readJournalTail(layout, TERMINAL, 20)).unreadableLines).toBe(0);
  });
});

describe('where a writer picks the numbering up', () => {
  it('answers zero for a file that is not there', async () => {
    expect(await lastSequenceIn(join(eventsDir(), '2026-08-10.ndjson'))).toBe(0);
  });

  it('answers zero for a file it cannot read, and the reader then reports the restart', async () => {
    await mkdir(join(eventsDir(), '2026-08-10.ndjson'), { recursive: true });

    expect(await lastSequenceIn(join(eventsDir(), '2026-08-10.ndjson'))).toBe(0);
  });

  it('answers the highest number present, not the last line', async () => {
    // A file whose tail is torn still knows how far the numbering got.
    await writeDay('2026-08-10', line(1, 1), line(3, 3), line(2, 2));

    expect(await lastSequenceIn(join(eventsDir(), '2026-08-10.ndjson'))).toBe(3);
  });

  it('is what the writer actually uses, end to end', async () => {
    const journal = new FileEventJournal({
      layout,
      logger: new RecordingLogger(),
      policy: DEFAULT_JOURNAL_POLICY,
    });
    await journal.append({ terminalId: TERMINAL, receivedAt: AT, raw: '{"n":1}' });

    const day = AT.toLocaleDateString('sv-SE');
    expect(await lastSequenceIn(join(eventsDir(), `${day}.ndjson`))).toBe(1);
  });
});
