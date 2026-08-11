import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileEventJournal,
  StorageError,
  TerminalId,
  isErrorOfCode,
} from '../../packages/core/src/index';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * The oracle for the only thing in M1 that cannot be recovered later.
 *
 * §10.1а names five places where M1 could close the road to the strategy, and
 * four of them cost a schema migration if we get them wrong. This one costs
 * everything: an event consumed and not written is gone, and no later version
 * can go back for it. So the journal exists from the first version of the
 * receiver, and it stores the RAW envelope -- not our reading of it, which is
 * the part that will change.
 *
 * On a real directory rather than a fake, for the reason M1.6 gave: creating a
 * directory, appending to a file and the shape of an OS refusal are exactly
 * what a fake is free to lie about, and every test built on the lie agrees.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-journal-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function journal(): FileEventJournal {
  return new FileEventJournal(root);
}

async function linesOf(terminalId = TERMINAL): Promise<string[]> {
  const path = join(root, 'terminals', terminalId.value, 'events.ndjson');
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

function entry(raw: string, at = '2026-08-11T09:00:00.000Z'): Parameters<FileEventJournal['append']>[0] {
  return { terminalId: TERMINAL, receivedAt: new Date(at), raw };
}

interface JournalLine {
  readonly at: string;
  readonly terminalId: string;
  readonly raw: string;
}

/** One line as it was written. Typed here so the assertions are not `any` comparisons. */
function parseLine(line: string | undefined): JournalLine {
  return JSON.parse(line ?? '') as JournalLine;
}

describe('FileEventJournal writes a journal, not a snapshot', () => {
  it('creates the terminal directory on the first append', async () => {
    await journal().append(entry('{"hook_event_name":"Stop"}'));
    expect(await linesOf()).toHaveLength(1);
  });

  it('appends rather than replaces', async () => {
    const j = journal();
    await j.append(entry('{"n":1}'));
    await j.append(entry('{"n":2}'));
    await j.append(entry('{"n":3}'));

    const lines = await linesOf();
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => parseLine(line).raw)).toStrictEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });

  it('keeps the arrival time and the terminal beside the body', async () => {
    await journal().append(entry('{"n":1}', '2026-08-11T09:30:15.250Z'));

    const [line] = await linesOf();
    expect(parseLine(line)).toStrictEqual({
      at: '2026-08-11T09:30:15.250Z',
      terminalId: TERMINAL_UUID,
      raw: '{"n":1}',
    });
  });

  it('gives each terminal its own journal', async () => {
    const other = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
    const j = journal();
    await j.append(entry('{"mine":true}'));
    await j.append({ terminalId: other, receivedAt: new Date(), raw: '{"theirs":true}' });

    expect(await linesOf()).toHaveLength(1);
    expect(await linesOf(other)).toHaveLength(1);
  });
});

describe('FileEventJournal keeps the body byte for byte', () => {
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
    await journal().append(entry(raw));

    const [line] = await linesOf();
    expect(parseLine(line).raw).toBe(raw);
  });

  it.each(BODIES)('%s still leaves exactly one line', async (_label, raw) => {
    await journal().append(entry(raw));
    expect(await linesOf()).toHaveLength(1);
  });
});

describe('FileEventJournal under concurrency', () => {
  it('does not interleave appends issued at once', async () => {
    const j = journal();
    const count = 40;

    // What this DOES prove: forty appends issued in one tick produce forty
    // well-formed lines and lose none of them.
    //
    // What it does NOT prove, said here rather than implied: that the queue
    // inside the journal is what makes that true. A mutation removing it
    // survives -- at this size and at 128 KB per line, checked 2026-08-11 --
    // because `O_APPEND` on Windows landed every write whole anyway. The queue
    // stays because the guarantee is not one the platform makes and a torn line
    // is a permanent hole in a history nobody reads until later; but it is
    // recorded as unproven (§8.2), not asserted.
    const padding = 'x'.repeat(4096);
    await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        await j.append(entry(`{"n":${index},"pad":"${padding}"}`));
      })
    );

    const lines = await linesOf();
    expect(lines).toHaveLength(count);
    // Every line parses: a torn write shows up here and nowhere else.
    const numbers = lines.map((line) => (JSON.parse(parseLine(line).raw) as { n: number }).n);
    expect([...numbers].sort((a, b) => a - b)).toStrictEqual(
      Array.from({ length: count }, (_unused, index) => index)
    );
  });
});

describe('FileEventJournal when the file system refuses', () => {
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
    expect(String((caught as StorageError).details.path)).toContain('events.ndjson');
  });

  it('does not poison the queue for later appends', async () => {
    // A journal that stopped working after one refusal would lose every event
    // from then on, silently -- the exact failure this file exists to prevent.
    const blocked = new FileEventJournal(join(root, 'nested'));
    await writeFile(join(root, 'nested'), 'in the way', 'utf8');
    await expect(blocked.append(entry('{"n":1}'))).rejects.toBeInstanceOf(StorageError);

    await rm(join(root, 'nested'));
    await blocked.append(entry('{"n":2}'));

    const path = join(root, 'nested', 'terminals', TERMINAL_UUID, 'events.ndjson');
    expect(await readFile(path, 'utf8')).toContain('{\\"n\\":2}');
  });
});
