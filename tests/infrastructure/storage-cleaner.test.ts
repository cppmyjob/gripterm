import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRASH_SWEEP_INTERVAL_MS,
  MAX_EXPIRED_PER_PASS,
  SETTLED_MS,
  StorageCleaner,
  StorageLayout,
  TerminalId,
  trashStamp,
} from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';

/**
 * The store as the cleanup meets it: a real directory, with leftovers in it.
 *
 * A fake file system would be free to make a directory move atomic when it is
 * not, and free to answer `readdir` about a directory being written into. Both
 * are exactly what this class has to be right about -- it is the one thing in
 * the build that MOVES a person's records without being asked about each one.
 */

const RETENTION_DAYS = 14;
const MS_PER_DAY = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const TERMINAL_A = '11111111-1111-4111-8111-111111111111';
const TERMINAL_B = '22222222-2222-4222-8222-222222222222';

interface Built {
  readonly cleaner: StorageCleaner;
  readonly layout: StorageLayout;
  readonly clock: FixedClock;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly dir: string;
}

/**
 * The clock starts at the real moment, because the files below are made by the
 * real file system and carry real timestamps: a clock in the past would make
 * every directory look as if it had just been written.
 */
const made: string[] = [];

async function build(intervalMs?: number): Promise<Built> {
  const dir = await mkdtemp(join(tmpdir(), 'gripterm-cleaner-'));
  made.push(dir);
  const layout = new StorageLayout(dir);
  const clock = new FixedClock(new Date());
  const scheduler = new FakeScheduler();
  const logger = new RecordingLogger();
  const cleaner = new StorageCleaner({
    layout,
    clock,
    scheduler,
    logger,
    retentionDays: RETENTION_DAYS,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });
  return { cleaner, layout, clock, scheduler, logger, dir };
}

/** A terminal directory with something in it, aged so that the guard lets it go. */
async function leftover(layout: StorageLayout, name: string, files: readonly string[]): Promise<string> {
  const path = join(layout.terminalsDir, name);
  await mkdir(path, { recursive: true });
  for (const file of files) {
    const target = join(path, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, `contents of ${file}`, 'utf8');
  }
  await settle(path);
  return path;
}

/** Puts a directory's last-touched moment far enough back to be swept. */
async function settle(path: string): Promise<void> {
  const old = new Date(Date.now() - 10 * MINUTE_MS);
  await utimes(path, old, old);
}

/** A batch in the trash stamped at a given moment, with a record in it. */
async function batch(layout: StorageLayout, at: Date): Promise<string> {
  const name = trashStamp(at);
  await mkdir(join(layout.trashDir, name, TERMINAL_A), { recursive: true });
  await writeFile(join(layout.trashDir, name, TERMINAL_A, 'record.json'), '{}', 'utf8');
  return name;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function namesIn(path: string): Promise<readonly string[]> {
  return [...(await readdir(path))].sort();
}

describe('finding what is left in the store that nothing points at', () => {
  it('finds a directory holding no record any window could read', async () => {
    // What `remove` leaves behind (M2.7): the two cards go to the trash and the
    // journal stays. Nothing lists such a directory and nothing ever will --
    // the repository skips it, so it is invisible rubbish until this.
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['settings.json', 'events/2026-08-01.ndjson']);

    expect(await cleaner.strays(new Set())).toStrictEqual([TERMINAL_A]);
  });

  it('leaves the directory of a record that was read', async () => {
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['record.json']);

    expect(await cleaner.strays(new Set([TERMINAL_A]))).toStrictEqual([]);
  });

  it('leaves a directory something wrote a moment ago', async () => {
    // A terminal being created has a directory before it has a record (the
    // repository says so). Without this guard the cleanup would carry off a
    // record another window is in the middle of writing.
    const { cleaner, layout } = await build();
    await mkdir(join(layout.terminalsDir, TERMINAL_B), { recursive: true });

    expect(await cleaner.strays(new Set())).toStrictEqual([]);
  });

  it('finds a directory whose name could never be a record of ours', async () => {
    // The repository refuses to read it at all -- the name is not a terminal id
    // -- so it can never appear in any list, and only a sweep over directories
    // can reach it.
    const { cleaner, layout } = await build();
    await leftover(layout, 'not-a-terminal', ['stray.txt']);

    expect(await cleaner.strays(new Set())).toStrictEqual(['not-a-terminal']);
  });

  it('leaves a file lying in the terminals directory alone', async () => {
    // It is asked for directories that hold no record, and a file holds
    // nothing at all: whatever it is, it is not a leftover of ours.
    const { cleaner, layout } = await build();
    await mkdir(layout.terminalsDir, { recursive: true });
    await writeFile(join(layout.terminalsDir, 'notes.txt'), 'mine', 'utf8');
    // Aged, so that the only thing left to save it is being a file.
    await settle(join(layout.terminalsDir, 'notes.txt'));

    expect(await cleaner.strays(new Set())).toStrictEqual([]);
  });

  it('finds nothing in a store that holds no terminals at all', async () => {
    const { cleaner } = await build();

    expect(await cleaner.strays(new Set())).toStrictEqual([]);
  });
});

describe('moving what was found into the trash', () => {
  it('moves a whole directory, history and settings included', async () => {
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, [
      'record.json',
      'observed.json',
      'settings.json',
      'events/2026-08-01.ndjson',
    ]);

    const outcome = await cleaner.sweep([TERMINAL_A]);

    expect(outcome.moved).toStrictEqual([TERMINAL_A]);
    expect(outcome.failed).toStrictEqual([]);
    expect(await exists(join(layout.terminalsDir, TERMINAL_A))).toBe(false);
    const moved = join(layout.trashDir, outcome.batch, TERMINAL_A);
    expect(await namesIn(moved)).toStrictEqual([
      'events',
      'observed.json',
      'record.json',
      'settings.json',
    ]);
    expect(await readFile(join(moved, 'record.json'), 'utf8')).toBe('contents of record.json');
    expect(await namesIn(join(moved, 'events'))).toStrictEqual(['2026-08-01.ndjson']);
  });

  it('can be moved back, which is the whole reason it is a move', async () => {
    // The rollback of §I.3, and it needs no tool of ours: the directory keeps
    // its name and everything under it, so putting it back is one rename.
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['record.json', 'events/2026-08-01.ndjson']);

    const outcome = await cleaner.sweep([TERMINAL_A]);
    await rename(
      join(layout.trashDir, outcome.batch, TERMINAL_A),
      join(layout.terminalsDir, TERMINAL_A)
    );

    expect(await readFile(layout.recordFile(TerminalId.fromString(TERMINAL_A)), 'utf8')).toBe(
      'contents of record.json'
    );
  });

  it('puts everything from one run into one batch', async () => {
    // One run, one folder to look in and one folder to put back. Two stamps
    // would make an undo a hunt through the trash for pieces of one decision.
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['record.json']);
    await leftover(layout, TERMINAL_B, ['record.json']);

    const outcome = await cleaner.sweep([TERMINAL_A, TERMINAL_B]);

    expect(await namesIn(layout.trashDir)).toStrictEqual([outcome.batch]);
    expect(await namesIn(join(layout.trashDir, outcome.batch))).toStrictEqual(
      [TERMINAL_A, TERMINAL_B].sort()
    );
  });

  it('moves the rest when one of them cannot be moved', async () => {
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['record.json']);

    const outcome = await cleaner.sweep([TERMINAL_B, TERMINAL_A]);

    expect(outcome.moved).toStrictEqual([TERMINAL_A]);
    expect(outcome.failed.map((failure) => failure.name)).toStrictEqual([TERMINAL_B]);
    expect(outcome.failed[0]?.reason.length).toBeGreaterThan(0);
  });

  it('refuses a name that would leave the terminals directory', async () => {
    // The names come off the medium, so this is the one place an untrusted
    // string becomes a path -- and `..` would move the whole store.
    const { cleaner, layout } = await build();
    await leftover(layout, TERMINAL_A, ['record.json']);

    const outcome = await cleaner.sweep(['..']);

    expect(outcome.moved).toStrictEqual([]);
    expect(outcome.failed.map((failure) => failure.name)).toStrictEqual(['..']);
    expect(await exists(join(layout.terminalsDir, TERMINAL_A))).toBe(true);
  });

  it('makes no batch at all when there is nothing to move', async () => {
    const { cleaner, layout } = await build();

    const outcome = await cleaner.sweep([]);

    expect(outcome.moved).toStrictEqual([]);
    expect(await exists(layout.trashDir)).toBe(false);
  });
});

describe('the pass over the trash', () => {
  it('removes a batch older than the retention', async () => {
    const { cleaner, layout, clock, logger } = await build();
    const old = trashStamp(new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    await mkdir(join(layout.trashDir, old, TERMINAL_A), { recursive: true });
    await writeFile(join(layout.trashDir, old, TERMINAL_A, 'record.json'), '{}', 'utf8');

    const outcome = await cleaner.collect();

    expect(outcome.expired).toStrictEqual([old]);
    expect(await exists(join(layout.trashDir, old))).toBe(false);
    expect(logger.infos.some((line) => JSON.stringify(line.details ?? {}).includes(old))).toBe(true);
  });

  it('keeps a batch inside the retention', async () => {
    const { cleaner, layout, clock } = await build();
    const recent = trashStamp(new Date(clock.now().getTime() - (RETENTION_DAYS - 1) * MS_PER_DAY));
    await mkdir(join(layout.trashDir, recent, TERMINAL_A), { recursive: true });
    await writeFile(join(layout.trashDir, recent, TERMINAL_A, 'record.json'), '{}', 'utf8');

    const outcome = await cleaner.collect();

    expect(outcome.expired).toStrictEqual([]);
    expect(await exists(join(layout.trashDir, recent))).toBe(true);
  });

  it('keeps a batch dated exactly at the cutoff, because the retention is days KEPT', async () => {
    const { cleaner, layout, clock } = await build();
    const edge = trashStamp(new Date(clock.now().getTime() - RETENTION_DAYS * MS_PER_DAY));
    await mkdir(join(layout.trashDir, edge, TERMINAL_A), { recursive: true });
    await writeFile(join(layout.trashDir, edge, TERMINAL_A, 'record.json'), '{}', 'utf8');

    expect((await cleaner.collect()).expired).toStrictEqual([]);
    expect(await exists(join(layout.trashDir, edge))).toBe(true);
  });

  it('takes away a batch that holds nothing at all, whatever its age', async () => {
    // Observed on 2026-08-13: a presence file collected by another window can
    // vanish between the survey and the move, and the destination directory --
    // made before the move -- stays behind empty. An empty batch reads as "we
    // carried something off in here", and waiting out the retention to say
    // otherwise is a fortnight of a lie.
    const { cleaner, layout, clock } = await build();
    const recent = trashStamp(new Date(clock.now().getTime() - 5 * MINUTE_MS));
    await mkdir(join(layout.trashDir, recent, 'owners'), { recursive: true });

    const outcome = await cleaner.collect();

    expect(outcome.empty).toStrictEqual([recent]);
    expect(await exists(join(layout.trashDir, recent))).toBe(false);
  });

  it('takes the empty half of a batch and leaves the rest', async () => {
    const { cleaner, layout, clock } = await build();
    const recent = trashStamp(new Date(clock.now().getTime() - 5 * MINUTE_MS));
    await mkdir(join(layout.trashDir, recent, 'owners'), { recursive: true });
    await mkdir(join(layout.trashDir, recent, TERMINAL_A), { recursive: true });
    await writeFile(join(layout.trashDir, recent, TERMINAL_A, 'record.json'), '{}', 'utf8');

    const outcome = await cleaner.collect();

    expect(outcome.empty).toStrictEqual([join(recent, 'owners')]);
    expect(await namesIn(join(layout.trashDir, recent))).toStrictEqual([TERMINAL_A]);
  });

  it('leaves an empty batch that was made a moment ago', async () => {
    // A directory made and not yet moved into belongs to a window that is
    // between two system calls, not to a run that failed.
    const { cleaner, layout, clock } = await build();
    const now = trashStamp(clock.now());
    await mkdir(join(layout.trashDir, now), { recursive: true });

    const outcome = await cleaner.collect();

    expect(outcome.empty).toStrictEqual([]);
    expect(await exists(join(layout.trashDir, now))).toBe(true);
  });

  it('leaves a directory in the trash that it did not put there', async () => {
    // `rm -rf` by a rule is only defensible over names this build made itself.
    // The name here is deliberately one that would sort BEFORE the cutoff: a
    // sweep that compared every name to a date would take a person's own copy
    // of their records away, which is the worst thing in this file that could
    // happen and the cheapest to prevent.
    const { cleaner, layout } = await build();
    const mine = join(layout.trashDir, '2025-holiday-backup');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, 'record.json'), 'the copy I made', 'utf8');
    await settle(mine);

    const outcome = await cleaner.collect();

    expect(outcome).toStrictEqual({ expired: [], empty: [], heldBack: [], refused: null });
    expect(await readFile(join(mine, 'record.json'), 'utf8')).toBe('the copy I made');
  });

  it('calls a store nobody has thrown anything away in empty, and says nothing about it', async () => {
    const { cleaner, logger } = await build();

    expect(await cleaner.collect()).toStrictEqual({ expired: [], empty: [], heldBack: [], refused: null });
    expect(logger.warnings).toStrictEqual([]);
  });

  it('reports a trash it cannot read rather than calling it empty', async () => {
    // The difference decides what the person is told. "Nothing to collect" and
    // "the trash would not open" are the same value only in code about to be
    // wrong about a disk that is filling up.
    const { cleaner, layout } = await build();
    await writeFile(layout.trashDir, 'not a directory', 'utf8');

    await expect(cleaner.collect()).rejects.toThrow();
  });
});

describe('the clock the pass reads, which is the wall clock and does not only move forwards', () => {
  it('removes no more batches in one pass than the ceiling names', async () => {
    // S44, the ceiling. A clock that drifted by LESS than the retention makes
    // nearly every batch look expired at once, and nothing in the store can see
    // the drift: thirteen days against a fortnight is not a jump anything could
    // refuse. The ceiling is what is left, and it is why the acceptance of this
    // step was rewritten -- the old one ("a year forward is refused") stays
    // green on a build with no ceiling at all.
    const { cleaner, layout, clock, logger } = await build();
    const over = 5;
    const names: string[] = [];
    for (let index = 0; index < MAX_EXPIRED_PER_PASS + over; index += 1) {
      // Two days back and an hour apart: distinct stamps, all of them well
      // inside the retention until the drift.
      names.push(await batch(layout, new Date(clock.now().getTime() - 2 * MS_PER_DAY - index * HOUR_MS)));
    }
    // A pass at the right clock. It removes nothing, and leaves the mark the
    // next one measures the drift against.
    expect((await cleaner.collect()).expired).toStrictEqual([]);

    clock.advance((RETENTION_DAYS - 1) * MS_PER_DAY);
    const outcome = await cleaner.collect();

    expect(outcome.refused).toBeNull();
    expect(outcome.expired).toHaveLength(MAX_EXPIRED_PER_PASS);
    expect(outcome.heldBack).toHaveLength(over);
    // The oldest went and the newest stayed: what a capped pass keeps is what a
    // person is likeliest to still want.
    expect([...outcome.expired]).toStrictEqual([...names].sort().slice(0, MAX_EXPIRED_PER_PASS));
    expect(await namesIn(layout.trashDir)).toStrictEqual([...outcome.heldBack]);
    expect(logger.warnings.some((line) => line.message.includes('only so many batches'))).toBe(true);
  });

  it('makes no pass at all when the clock stands further ahead than the retention', async () => {
    // S44, the refusal. A jump longer than the retention is an incident -- NTP
    // on a flat battery, a snapshot resumed, a date corrected by hand -- and an
    // incident is not a reason to empty the one directory every undo needs.
    const { cleaner, layout, clock } = await build();
    expect((await cleaner.collect()).refused).toBeNull();
    const old = await batch(layout, new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));

    clock.advance((RETENTION_DAYS + 1) * MS_PER_DAY);
    const outcome = await cleaner.collect();

    expect(outcome.refused).toContain('the clock stands');
    expect(outcome.expired).toStrictEqual([]);
    expect(await exists(join(layout.trashDir, old))).toBe(true);
  });

  it('says the refusal to the person, and not only in what it returns', async () => {
    // The load-bearing half of the acceptance. The one production caller does
    // `void cleaner.collect().catch(...)`, so a refusal that lives only in the
    // returned value is a refusal nobody is ever told about -- and a test over
    // that value stays green above the silence.
    const { cleaner, clock, logger } = await build();
    await cleaner.collect();
    clock.advance((RETENTION_DAYS + 1) * MS_PER_DAY);

    await cleaner.collect();

    const said = logger.warnings.filter((line) => line.message.includes('the clock stands further past'));
    expect(said).toHaveLength(1);
    // And it names the one act that accepts the new clock, because a refusal
    // with no way out of it is a store nothing ever sweeps again.
    expect(JSON.stringify(said[0]?.details ?? {})).toContain('trash-sweep.json');
  });

  it('leaves the mark where it was, so a clock put back needs nothing from anybody', async () => {
    // Why a refusal does not move the mark on. Were it written at a refusal,
    // the next pass would measure from the jumped clock, see nothing wrong and
    // remove everything -- a refusal worth exactly one pass.
    const { cleaner, layout, clock } = await build();
    await cleaner.collect();
    const old = await batch(layout, new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    clock.advance(365 * MS_PER_DAY);
    expect((await cleaner.collect()).refused).not.toBeNull();

    clock.advance(-365 * MS_PER_DAY);
    const outcome = await cleaner.collect();

    expect(outcome.refused).toBeNull();
    expect(outcome.expired).toStrictEqual([old]);
  });

  it('makes the pass when nothing says when the last one was', async () => {
    // A fresh profile, or the first window of this build over a store swept for
    // months. There is nothing to measure a clock against, and refusing on
    // absence would be a build that collects nothing until a person deletes a
    // file. That case belongs to the ceiling, which needs no history.
    const { cleaner, layout, clock } = await build();
    const old = await batch(layout, new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));

    const outcome = await cleaner.collect();

    expect(outcome.expired).toStrictEqual([old]);
    expect(await exists(layout.trashSweepFile)).toBe(true);
  });

  it('leaves its mark even when it removed nothing at all', async () => {
    // Otherwise the clock is measurable only in a store somebody is deleting
    // things from, and the quiet store is the one that sits through the jump.
    const { cleaner, layout, clock } = await build();

    await cleaner.collect();

    const mark: unknown = JSON.parse(await readFile(layout.trashSweepFile, 'utf8'));
    expect(mark).toStrictEqual({ at: clock.now().toISOString() });
  });

  it('says so and sweeps on when the mark is not readable', async () => {
    const { cleaner, layout, clock, logger } = await build();
    const old = await batch(layout, new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    await writeFile(layout.trashSweepFile, 'not json at all', 'utf8');

    const outcome = await cleaner.collect();

    expect(outcome.expired).toStrictEqual([old]);
    expect(logger.warnings.some((line) => line.message.includes('mark left by the last pass'))).toBe(true);
  });

  it('says so and sweeps on when the mark holds no moment', async () => {
    // A different failure from the one above, and told apart in the reason:
    // this file parsed, so what is wrong with it is ours to explain.
    const { cleaner, layout, clock, logger } = await build();
    const old = await batch(layout, new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    await writeFile(layout.trashSweepFile, '{"when":"yesterday"}', 'utf8');

    const outcome = await cleaner.collect();

    expect(outcome.expired).toStrictEqual([old]);
    expect(
      logger.warnings.some((line) => JSON.stringify(line.details ?? {}).includes('no moment'))
    ).toBe(true);
  });
});

describe('the pass as a repeating thing', () => {
  it('arms nothing until it is started, and then sweeps on the interval', async () => {
    const { cleaner, layout, clock, scheduler } = await build();
    const old = trashStamp(new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    await mkdir(join(layout.trashDir, old, TERMINAL_A), { recursive: true });
    expect(scheduler.armed).toHaveLength(0);

    cleaner.start();
    expect(scheduler.live[0]?.ms).toBe(DEFAULT_TRASH_SWEEP_INTERVAL_MS);
    scheduler.elapse();
    // Waited for by the re-arming and not by the batch's removal, and the
    // difference is a whole pass wide: `_arm` runs in a `finally`, AFTER the
    // batch is gone and after the mark is written. A test that waited on the
    // batch read the timer through that gap and found nothing armed -- red
    // about once in five runs on a loaded machine, and only there, which is
    // why it read as weather rather than as a bug for a week.
    await until(() => scheduler.live.length > 0);

    expect(await exists(join(layout.trashDir, old))).toBe(false);
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.ms).toBe(DEFAULT_TRASH_SWEEP_INTERVAL_MS);
    cleaner.dispose();
  });

  it('takes the interval it was given', async () => {
    const { cleaner, scheduler } = await build(90_000);

    cleaner.start();

    expect(scheduler.live[0]?.ms).toBe(90_000);
    cleaner.dispose();
  });

  it('keeps sweeping after a pass that could not read the trash', async () => {
    const { cleaner, layout, scheduler, logger } = await build();
    await writeFile(layout.trashDir, 'not a directory', 'utf8');
    cleaner.start();

    scheduler.elapse();
    await until(async () => logger.warnings.length > 0);

    expect(scheduler.live).toHaveLength(1);
    cleaner.dispose();
  });

  it('stops when the window closes', async () => {
    const { cleaner, scheduler } = await build();
    cleaner.start();

    cleaner.dispose();

    expect(scheduler.live).toHaveLength(0);
  });

  it('does not arm itself again when it was disposed mid-pass', async () => {
    const { cleaner, layout, clock, scheduler } = await build();
    const old = trashStamp(new Date(clock.now().getTime() - (RETENTION_DAYS + 1) * MS_PER_DAY));
    await mkdir(join(layout.trashDir, old), { recursive: true });
    cleaner.start();

    scheduler.elapse();
    cleaner.dispose();
    await until(async () => !(await exists(join(layout.trashDir, old))));

    expect(scheduler.live).toHaveLength(0);
  });

  it('is not started twice by a second call', async () => {
    const { cleaner, scheduler } = await build();

    cleaner.start();
    cleaner.start();

    expect(scheduler.live).toHaveLength(1);
    cleaner.dispose();
  });

  it('waits at least a minute before calling anything settled', () => {
    // One number, named where both rules read it: a directory nothing has
    // touched for this long is not one being written into right now.
    expect(SETTLED_MS).toBe(MINUTE_MS);
  });
});

afterAll(async () => {
  for (const dir of made) {
    await rm(dir, { force: true, recursive: true });
  }
});

/**
 * Waits for a pass to have happened, rather than for a number of turns.
 *
 * A pass over the trash is real file system work, so "let the microtasks run"
 * is not a thing a test can count: it would pass or fail on how many awaits the
 * implementation happens to have.
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
  throw new Error('the pass never finished');
}
