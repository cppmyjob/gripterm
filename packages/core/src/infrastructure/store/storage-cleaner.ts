import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STORAGE_DIRECTORY_MODE, isTrashBatchName, journalDay, trashStamp } from './storage-layout';
import { moveAtomic } from './atomic-file';
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
   * Throws if the trash cannot be read, and treats "no trash at all" as the
   * empty answer it is.
   */
  public async collect(): Promise<CollectOutcome> {
    const { layout, logger, retentionDays } = this._options;
    const at = this._options.clock.now();
    // Millisecond arithmetic against a local day, the same tolerance the
    // journal's retention takes: around a daylight-saving change this can be a
    // day out, and a date library would cost more than it saves.
    const cutoff = journalDay(new Date(at.getTime() - retentionDays * MS_PER_DAY));
    const settled = trashStamp(new Date(at.getTime() - SETTLED_MS));

    const expired: string[] = [];
    const empty: string[] = [];
    for (const name of await this._batchNames()) {
      const path = join(layout.trashDir, name);
      if (name.slice(0, cutoff.length) < cutoff) {
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
    return { expired, empty };
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
