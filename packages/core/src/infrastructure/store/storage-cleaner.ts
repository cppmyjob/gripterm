import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STORAGE_DIRECTORY_MODE, isTrashBatchName, journalDay, trashStamp } from './storage-layout';
import { moveAtomic } from './atomic-file';
import { readJsonFile, writeJsonFile } from './json-file';
import { asRecord, asString } from '../../domain/json/json-readers';
import type { Clock } from '../../domain/ports/clock';
import type { Disposable } from '../../domain/ports/disposable';
import type { Logger } from '../../domain/ports/logger';
import type { Scheduler } from '../../domain/ports/scheduler';
import type { StorageLayout } from './storage-layout';

/**
 * How long a directory must have gone untouched before it counts as left
 * behind rather than being written into.
 *
 * The hazard is one system call wide: a terminal being created has a directory
 * before it has a record (the repository says so), and a batch in the trash is
 * made an instant before anything is moved into it. A minute is three orders of
 * magnitude more than either gap and still short enough that a person cleaning
 * up sees this run's leftovers go on the next one.
 */
export const SETTLED_MS = 60_000;

/** Once a day, because what it removes is measured in days. */
export const DEFAULT_TRASH_SWEEP_INTERVAL_MS = 86_400_000;

const MS_PER_DAY = 86_400_000;

/**
 * How many batches one pass may remove for good.
 *
 * On the IRREVERSIBLE half only. An empty batch holds nothing, so taking one
 * away destroys nothing and is not counted here.
 *
 * Sixteen, because a batch is made per act of sweeping -- one record thrown
 * away, one presence file collected, one run of the cleanup command -- so
 * ordinary use makes a few a day and a pass in a healthy store never comes near
 * it. What it is for is the drift the refusal below cannot see: a clock that
 * moved LESS than the retention makes nearly every batch look expired at once,
 * and no jump was made that anything could notice. A pass with a ceiling takes
 * sixteen of them, leaves the rest where they are and says so.
 *
 * A person whose store really does make more than sixteen batches a day meets
 * that same warning, and it is true of their store: the trash holds more than
 * the retention promised it would.
 */
export const MAX_EXPIRED_PER_PASS = 16;

export interface StorageCleanerOptions {
  readonly layout: StorageLayout;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /**
   * How many days a batch in the trash is kept.
   *
   * The journal's number (`gripterm.journal.retentionDays`), deliberately. One
   * answer to "how long does this build keep things", set in one place; a
   * second knob would be a setting nobody sets and a surprise for whoever
   * changed the first one.
   */
  readonly retentionDays: number;
  readonly intervalMs?: number;
}

export interface SweepFailure {
  readonly name: string;
  readonly reason: string;
}

export interface SweepOutcome {
  /** The batch everything from this run went into: `trash/<stamp>/`. */
  readonly batch: string;
  readonly moved: readonly string[];
  readonly failed: readonly SweepFailure[];
}

export interface CollectOutcome {
  /** Batches removed for good, because they are older than the retention. */
  readonly expired: readonly string[];
  /** Directories removed because they held nothing at all, relative to `trash/`. */
  readonly empty: readonly string[];
  /**
   * Batches old enough to go that the ceiling kept, oldest first.
   *
   * Empty when the pass was refused: it was the refusal that kept them then,
   * and nothing looked at the trash at all.
   */
  readonly heldBack: readonly string[];
  /** Why no pass was made, or `null` when one was. */
  readonly refused: string | null;
}

/**
 * The part of the cleanup that touches the medium, and understands nothing.
 *
 * The decision about which RECORDS may go is a pure function over the same
 * world the restore predicate reads (`planCleanup`). This class is handed names
 * and moves directories -- which is what makes it able to reach the one kind of
 * rubbish nothing else can: a directory holding no readable record. Such a
 * directory is invisible to every list in the build (the repository skips it),
 * so it would otherwise sit in the store for ever, and every record ever
 * deleted leaves one -- `remove` takes the two cards and leaves the journal
 * (M2.7).
 *
 * NOTHING HERE DELETES A RECORD. A sweep is a rename into `trash/<stamp>/`,
 * which is the rollback made first (§I.3): the directory keeps its name and
 * everything under it, so putting it back is one move and needs no tool of
 * ours. The one irreversible act in this file is `collect`, which removes
 * batches older than the retention -- and that is the retention itself, stated
 * by the person, logged per batch with the rule that removed it.
 */
export class StorageCleaner implements Disposable {
  private _timer: Disposable | null = null;
  private _disposed = false;

  constructor(private readonly _options: StorageCleanerOptions) {}

  /**
   * Directories under `terminals/` that no record could be read from.
   *
   * `known` is the ids of the records that WERE read, and it comes from the
   * caller for one reason: it must be the same reading the plan was made
   * against. A second reading here could disagree with the first about a
   * record written between them -- and the disagreement would be a directory
   * moved out from under a record somebody is looking at.
   *
   * Throws if the store cannot be surveyed, and answers `[]` for a store with
   * no `terminals/` at all: a fresh profile is not a fault, and a directory
   * that would not stat is not a directory to guess about.
   */
  public async strays(known: ReadonlySet<string>): Promise<readonly string[]> {
    const { layout } = this._options;
    const settledBefore = this._options.clock.now().getTime() - SETTLED_MS;
    const found: string[] = [];

    for (const name of await this._directoriesIn(layout.terminalsDir)) {
      if (known.has(name)) {
        continue;
      }
      const touched = await stat(join(layout.terminalsDir, name));
      if (touched.mtimeMs < settledBefore) {
        found.push(name);
      }
    }
    return found.sort();
  }

  /**
   * Moves the named directories into one batch, and says what happened to each.
   *
   * One batch per run: a person undoing a cleanup has one directory to look in
   * and one decision to reverse.
   *
   * A name that could leave `terminals/` is refused by the layout, and the
   * destination is formed FIRST so that such a name never becomes a source path
   * either. A move that fails is reported and the rest go: the alternative is a
   * store nobody can clean because one directory is held open.
   */
  public async sweep(names: readonly string[]): Promise<SweepOutcome> {
    const at = this._options.clock.now();
    const { layout, logger } = this._options;
    const moved: string[] = [];
    const failed: SweepFailure[] = [];

    for (const name of names) {
      try {
        const to = layout.discardedStrayDir(at, name);
        // The batch is made before the move because `rename` needs its
        // destination's parent to be there. That is why an empty batch can be
        // left behind at all, and why `collect` takes them away rather than
        // this trying not to make them: making it lazily would mean reading a
        // failed rename's `ENOENT` as "the destination is missing" when it also
        // means "the source is missing", and guessing between them in exactly
        // the case that matters.
        await mkdir(layout.trashBatchDir(at), { recursive: true, mode: STORAGE_DIRECTORY_MODE });
        await moveAtomic(join(layout.terminalsDir, name), to);
        moved.push(name);
        logger.info('a terminal directory was moved to the trash', { name, movedTo: to });
      } catch (cause: unknown) {
        failed.push({ name, reason: String(cause) });
        logger.warn('a terminal directory could not be moved to the trash', {
          name,
          reason: String(cause),
        });
      }
    }
    return { batch: trashStamp(at), moved, failed };
  }

  /**
   * The pass over `trash/`: what is too old goes, and what holds nothing goes.
   *
   * Only over names this build made itself (`isTrashBatchName`). A directory
   * somebody put there is somebody's -- a copy made before trying something is
   * exactly what a folder called `trash` with records in it invites -- and a
   * rule that removed it would be this build deleting a person's backup.
   *
   * The empty half needs saying, because it looks like tidiness and is not: an
   * empty batch is a claim that something was carried off in there, and a
   * person looking for what they lost reads it as one. They appear for a reason
   * that cannot be designed away (see `sweep`), so they are collected instead
   * -- at any age, since a batch that holds nothing has nothing to keep for the
   * retention.
   *
   * Two guards stand in front of the removal, and they are the same hazard met
   * from two sides. A batch's age is read off the WALL CLOCK, which does not
   * only move forwards at one second per second: NTP on a machine with a flat
   * battery, a virtual machine resumed from a snapshot, a second system with
   * another RTC, a person correcting the date. A jump forwards makes every
   * batch look expired at once -- and `trash/` is the only way back from
   * `remove`, from the presence sweep and from `forgetClosedTerminals`. So a
   * jump LONGER than the retention refuses the pass outright, because a jump
   * like that is an incident and not a reason to remove anything; and a drift
   * shorter than the retention, which nothing can tell from time passing, meets
   * the ceiling instead (`MAX_EXPIRED_PER_PASS`).
   *
   * Throws if the trash cannot be read, and treats "no trash at all" as the
   * empty answer it is.
   */
  public async collect(): Promise<CollectOutcome> {
    const { layout, logger, retentionDays } = this._options;
    const at = this._options.clock.now();
    const refused = await this._reasonToRefuse(at);
    if (refused !== null) {
      // The mark is deliberately NOT moved on. Were it written here, the next
      // pass would measure from the jumped clock, find no jump and remove
      // everything -- which would make this refusal a delay of one pass. Left
      // where it is, it also means a clock PUT BACK needs nothing from anybody:
      // the gap to the last real pass is a normal one again.
      return { expired: [], empty: [], heldBack: [], refused };
    }
    // Millisecond arithmetic against a local day, the same tolerance the
    // journal's retention takes: around a daylight-saving change this can be a
    // day out, and a date library would cost more than it saves.
    const cutoff = journalDay(new Date(at.getTime() - retentionDays * MS_PER_DAY));
    const settled = trashStamp(new Date(at.getTime() - SETTLED_MS));

    const expired: string[] = [];
    const heldBack: string[] = [];
    const empty: string[] = [];
    for (const name of await this._batchNames()) {
      const path = join(layout.trashDir, name);
      if (name.slice(0, cutoff.length) < cutoff) {
        // Oldest first, because `_batchNames` sorts and the order is the
        // stamps' own: what a capped pass keeps is what a person is likeliest
        // to still want.
        if (expired.length >= MAX_EXPIRED_PER_PASS) {
          heldBack.push(name);
          continue;
        }
        await rm(path, { recursive: true, force: true });
        expired.push(name);
        logger.info('a batch in the trash was removed', {
          path,
          rule: `it is more than ${retentionDays} days old`,
        });
        continue;
      }
      if (name < settled) {
        await this._collectEmpty(path, name, empty);
      }
    }
    if (empty.length > 0) {
      logger.info('empty directories were taken out of the trash', { directories: empty });
    }
    if (heldBack.length > 0) {
      // A warning rather than a note. In a store whose clock is right this
      // never happens, so the line means one of two things and both are worth
      // a person's eye: the clock has drifted, or the trash is growing faster
      // than the retention takes it away.
      logger.warn('one pass may remove only so many batches, so the trash still holds some that are older than the retention', {
        removed: expired.length,
        left: heldBack.length,
        ceiling: MAX_EXPIRED_PER_PASS,
        trash: layout.trashDir,
      });
    }
    await this._rememberPass(at);
    return { expired, empty, heldBack, refused: null };
  }

  /** Begins the daily pass. A second call does nothing. */
  public start(): void {
    if (this._timer !== null) {
      return;
    }
    this._arm();
  }

  public dispose(): void {
    this._disposed = true;
    this._timer?.dispose();
    this._timer = null;
  }

  private _arm(): void {
    if (this._disposed) {
      return;
    }
    this._timer = this._options.scheduler.after(
      this._options.intervalMs ?? DEFAULT_TRASH_SWEEP_INTERVAL_MS,
      () => {
        void this._tick();
      }
    );
  }

  private async _tick(): Promise<void> {
    try {
      await this.collect();
    } catch (cause: unknown) {
      // A warning and not a stop. An uncollected trash is a disk that fills
      // slowly; a window that stopped sweeping because one pass met a locked
      // file is a machine where it never happens again.
      this._options.logger.warn('the trash could not be swept, so it may hold more than it should', {
        reason: String(cause),
      });
    } finally {
      this._arm();
    }
  }

  /**
   * Removes a directory that holds nothing but empty directories, deepest
   * first, and says whether it is gone.
   *
   * `rmdir` rather than a listing and then a decision: it removes a directory
   * ONLY if it is empty, atomically, so a file arriving between the two is the
   * refusal itself rather than a race this would have to reason about. Which is
   * also why its failure is not reported -- "it holds something" is the answer,
   * not a fault.
   */
  private async _collectEmpty(dir: string, relative: string, removed: string[]): Promise<boolean> {
    const mine: string[] = [];
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (child.isDirectory()) {
        await this._collectEmpty(join(dir, child.name), join(relative, child.name), mine);
      }
    }

    try {
      await rmdir(dir);
    } catch {
      removed.push(...mine);
      return false;
    }
    removed.push(relative);
    return true;
  }

  /**
   * Why this pass must not run, or `null` when it may.
   *
   * The measurement is the gap between now and the mark the last pass left. A
   * gap longer than the retention means every batch in the trash would go in a
   * single pass -- and the two things that make such a gap, a clock that jumped
   * and a machine that was off for a month, cannot be told apart from inside
   * the store. So both are refused, because the two mistakes do not cost the
   * same: keeping more than was promised costs disk, and removing the batches
   * is every undo a person has (I.3).
   *
   * The way out is one act by the person on one file, and the warning names it.
   */
  private async _reasonToRefuse(at: Date): Promise<string | null> {
    const { layout, logger, retentionDays } = this._options;
    const since = await this._lastPassAt();
    if (since === null) {
      return null;
    }
    const moved = at.getTime() - since.getTime();
    if (moved <= retentionDays * MS_PER_DAY) {
      return null;
    }
    const days = Math.round(moved / MS_PER_DAY);
    logger.warn(
      'the trash was left as it is, because the clock stands further past the last pass than the retention itself',
      {
        lastPass: since.toISOString(),
        now: at.toISOString(),
        movedDays: days,
        retentionDays,
        accept: `delete ${layout.trashSweepFile} to accept this clock -- the next pass then begins as a first one`,
      }
    );
    return (
      `the clock stands ${days} days past the last pass over the trash, which is longer than ` +
      `the ${retentionDays} days a batch is kept, so every batch in there would go at once`
    );
  }

  /**
   * When the last pass ran, or `null` when nothing readable says.
   *
   * `null` lets the pass go ahead. A store that never had one -- a fresh
   * profile, or the first window of this build over an old store -- has nothing
   * to measure a clock against, and refusing on absence would be a build that
   * collects nothing at all until a person deletes a file. That case is what
   * the ceiling is for: it needs no history.
   */
  private async _lastPassAt(): Promise<Date | null> {
    const file = this._options.layout.trashSweepFile;
    const read = await readJsonFile(file);
    if (read.kind === 'absent') {
      return null;
    }
    const written = read.kind === 'value' ? asString(asRecord(read.value)?.at) : null;
    const at = written === null ? null : new Date(written);
    if (at !== null && !Number.isNaN(at.getTime())) {
      return at;
    }
    this._options.logger.warn(
      'the mark left by the last pass over the trash could not be read, so this pass has nothing to measure the clock against',
      {
        file,
        reason: read.kind === 'unreadable' ? read.reason : 'it holds no moment under `at`',
      }
    );
    return null;
  }

  /**
   * Leaves the mark that this pass ran, which is the whole of what the next one
   * has to measure a clock against.
   *
   * After the removal and not before it, so a pass that threw does not claim to
   * have happened. A failure to write is a warning rather than a failure of the
   * pass, and the direction of that error is the reason: the next pass then
   * measures from an OLDER mark, so the only thing it makes easier is refusing.
   */
  private async _rememberPass(at: Date): Promise<void> {
    const file = this._options.layout.trashSweepFile;
    try {
      await writeJsonFile(file, { at: at.toISOString() });
    } catch (cause: unknown) {
      this._options.logger.warn(
        'the pass over the trash could not leave its mark, so the next one measures the clock from further back',
        { file, reason: String(cause) }
      );
    }
  }

  private async _batchNames(): Promise<readonly string[]> {
    return (await this._directoriesIn(this._options.layout.trashDir))
      .filter((name) => isTrashBatchName(name))
      .sort();
  }

  /**
   * The subdirectories of one place in the store, or none when the place is not
   * there yet.
   *
   * Absence is not a failure and everything else is: `terminals/` and `trash/`
   * are both made by the first thing that writes them, so a store where nobody
   * has thrown anything away has no `trash/` at all. Any other refusal is
   * reported to the caller, because this class is asked what to remove and
   * "the directory would not open" is not an answer that permits removing
   * anything.
   */
  private async _directoriesIn(path: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (cause: unknown) {
      if ((cause as { readonly code?: unknown }).code !== 'ENOENT') {
        throw cause;
      }
      return [];
    }
  }
}
