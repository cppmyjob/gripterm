import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoGoodbyeTally, StorageLayout } from '../../packages/core/src/index';
import { RecordingLogger } from '../helpers/port-fakes';
import type { LeftoverRun } from '../../packages/core/src/index';

/**
 * The running total behind the owner's question: how often does a run of this
 * build end without a goodbye.
 *
 * **Why it is a file and not a log line.** The line is written too -- and it is
 * what "Gripterm: Show Logs" shows -- but a log answers "did it happen this
 * time" and the question is "how many times this week". A window's log is one
 * activation's file, so counting them is a search over a directory; this holds
 * the number itself, in the same store, beside the records it is about.
 *
 * **Each run once, which is what `counted` is for.** A presence file left by a
 * window that is gone stays in `owners/` until something collects it, and the
 * reconciler will not while any record still names that window. So a second
 * start could meet the same file, and without a memory the totals would grow by
 * the number of windows a person opens rather than by what happened.
 */

const NOW = new Date('2026-08-31T12:00:00.000Z');

const made: string[] = [];

interface Built {
  readonly tally: NoGoodbyeTally;
  readonly layout: StorageLayout;
  readonly logger: RecordingLogger;
}

async function build(): Promise<Built> {
  const dir = await mkdtemp(join(tmpdir(), 'gripterm-goodbye-'));
  made.push(dir);
  const layout = new StorageLayout(dir);
  const logger = new RecordingLogger();
  return { tally: new NoGoodbyeTally({ layout, logger }), layout, logger };
}

function run(ownerId: string, heartbeatAtMs = NOW.getTime() - 30_000): LeftoverRun {
  return { ownerId, heartbeatAtMs };
}

async function fileOf(layout: StorageLayout): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(layout.noGoodbyeFile, 'utf8')) as Record<string, unknown>;
}

afterAll(async () => {
  for (const dir of made) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('the running total of runs that did not say goodbye', () => {
  it('says nothing and writes nothing when this start found none', async () => {
    const { tally, layout } = await build();

    await expect(tally.count([], new Set(), NOW)).resolves.toBeNull();
    await expect(readFile(layout.noGoodbyeFile, 'utf8')).rejects.toThrow();
  });

  it('counts the first one, and says so as a total of both kinds', async () => {
    const { tally, layout } = await build();

    const answer = await tally.count([run('window-1')], new Set(['window-1']), NOW);

    expect(answer?.counted.map((one) => one.ownerId)).toStrictEqual(['window-1']);
    expect(answer?.totals).toStrictEqual({ starts: 1, runs: 1 });
    expect(await fileOf(layout)).toStrictEqual({
      starts: 1,
      runs: 1,
      lastAt: NOW.toISOString(),
      counted: ['window-1'],
    });
  });

  it('counts two runs found by one start as one start and two runs', async () => {
    const { tally } = await build();

    const answer = await tally.count(
      [run('window-1'), run('window-2')],
      new Set(['window-1', 'window-2']),
      NOW
    );

    expect(answer?.totals).toStrictEqual({ starts: 1, runs: 2 });
  });

  it('does not count the same run twice when a later start meets the same file', async () => {
    // The case this memory exists for: the reconciler leaves a presence file
    // alone while a record still names that window, so the file outlives the
    // start that found it.
    const { tally } = await build();
    await tally.count([run('window-1')], new Set(['window-1']), NOW);

    const again = await tally.count([run('window-1')], new Set(['window-1']), NOW);

    expect(again).toBeNull();
  });

  it('counts a start that found one new run beside one it already knew', async () => {
    const { tally } = await build();
    await tally.count([run('window-1')], new Set(['window-1']), NOW);

    const answer = await tally.count(
      [run('window-1'), run('window-2')],
      new Set(['window-1', 'window-2']),
      NOW
    );

    expect(answer?.counted.map((one) => one.ownerId)).toStrictEqual(['window-2']);
    expect(answer?.totals).toStrictEqual({ starts: 2, runs: 2 });
  });

  it('forgets a name whose file has gone, and keeps the totals it stood for', async () => {
    // Bounded by what `owners/` holds, so the memory cannot grow without limit.
    // The totals never move backwards: what is dropped is the name, not the
    // count it was already added to.
    const { tally, layout } = await build();
    await tally.count([run('window-1')], new Set(['window-1']), NOW);

    await tally.count([run('window-2')], new Set(['window-2']), NOW);

    expect(await fileOf(layout)).toStrictEqual({
      starts: 2,
      runs: 2,
      lastAt: NOW.toISOString(),
      counted: ['window-2'],
    });
  });

  it('starts again from nought over a file that is missing a field, and says which', async () => {
    // Half a count is worse than none: the number is going to be quoted at a
    // decision worth several days, so all four fields or nothing.
    const { tally, layout, logger } = await build();
    await writeFile(layout.noGoodbyeFile, JSON.stringify({ starts: 7, runs: 9 }), 'utf8');

    const answer = await tally.count([run('window-1')], new Set(['window-1']), NOW);

    expect(answer?.totals).toStrictEqual({ starts: 1, runs: 1 });
    expect(logger.warnings[0]?.details?.reason).toContain('four fields');
  });

  it('goes on with the start when the count cannot be written, and says so', async () => {
    // An instrument bolted onto a start must never be able to stop one. What is
    // lost is the total; what is kept is the answer this start gives its caller,
    // which is what the log line beside it is written from.
    //
    // A directory where the file should be breaks BOTH halves -- the read and
    // the write -- which is why the warnings are read as a set rather than by
    // position: the point is that the start finished, not which complaint came
    // first.
    const { tally, layout, logger } = await build();
    await mkdir(layout.noGoodbyeFile, { recursive: true });

    const answer = await tally.count([run('window-1')], new Set(['window-1']), NOW);

    expect(answer?.totals).toStrictEqual({ starts: 1, runs: 1 });
    expect(logger.warnings.map((one) => one.message).join(' | ')).toContain('could not be written');
  });

  it('starts again from nought over a file it cannot read, and says so', async () => {
    // The direction of this failure is named rather than hidden: the totals
    // under-report what happened before the damage, and the same run may be
    // counted a second time. Both are visible in the log line beside it.
    const { tally, layout, logger } = await build();
    await tally.count([run('window-1')], new Set(['window-1']), NOW);
    await writeFile(layout.noGoodbyeFile, 'not json at all', 'utf8');

    const answer = await tally.count([run('window-1')], new Set(['window-1']), NOW);

    expect(answer?.totals).toStrictEqual({ starts: 1, runs: 1 });
    expect(logger.warnings[0]?.message).toContain('could not be read');
  });
});
