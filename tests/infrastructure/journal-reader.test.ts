import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  StorageLayout,
  TerminalId,
  lastSequenceIn,
  readJournal,
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
