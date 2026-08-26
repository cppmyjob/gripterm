import { constants, copyFile, mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  RECORD_FILE_NAME,
  STORAGE_DIRECTORY_MODE,
  isDiscardedOwnersArea,
  isTrashBatchName,
} from './storage-layout';
import { ConflictError, NotFoundError, StorageError } from '../../domain/errors/gripterm-error';
import { asRecord, asString } from '../../domain/json/json-readers';
import type { Dirent } from 'node:fs';
import type { Logger } from '../../domain/ports/logger';
import type { StorageLayout } from './storage-layout';

/**
 * The three shapes a thing in the trash can have, because a return that knows
 * one of them is a return that lies about the other two.
 *
 * They are not variants somebody chose here: each one is the print left by a
 * different way into `trash/`, and they differ in what a return has to DO.
 */
export type TrashForm =
  /**
   * The whole of a terminal's folder, as the cleanup and `forgetClosedTerminals`
   * leave it. Its home under `terminals/` is gone, so the return makes it again.
   */
  | 'whole-folder'
  /**
   * Only `record.json` and `observed.json`, as `remove()` leaves them -- the
   * terminal's own folder never left, with the journal and the settings still in
   * it. The return puts two files INTO a directory that is already there, which
   * is the case a rename would fail on.
   */
  | 'record-only'
  /** One presence file, as the reconciler's sweep leaves it in `owners/`. */
  | 'owner-file';

/** One thing a person can be offered back out of the trash. */
export interface TrashItem {
  /** The batch it went into, `trash/<stamp>/`, without the `trash/`. */
  readonly batch: string;
  /** The directory or file name it kept on the way in. */
  readonly name: string;
  readonly form: TrashForm;
  /** Where it lies now. */
  readonly from: string;
  /** Where it would go back to. */
  readonly to: string;
  /** What it holds, relative to `from`, so a person can see it is not empty. */
  readonly files: readonly string[];
  /** The name a person gave the terminal, when a record in there still says. */
  readonly displayName: string | null;
}

export interface TrashRestoreOutcome {
  readonly restoredTo: string;
  readonly files: readonly string[];
  /**
   * Whether the copy in the trash was taken away afterwards.
   *
   * `false` is not a failure of the return: the half that was asked for -- the
   * record back in the store -- has happened, and what is left behind is a
   * second copy of something the person has. Said rather than swallowed, because
   * a person who then looks in the trash finds it still there.
   */
  readonly trashCopyRemoved: boolean;
}

export interface TrashStoreOptions {
  readonly layout: StorageLayout;
  readonly logger: Logger;
}

/** One file on its way back, with the name it will be known by in a report. */
interface Leg {
  readonly from: string;
  readonly to: string;
  readonly relative: string;
}

/**
 * The way back out of `trash/`, which until this existed was a file manager.
 *
 * **What this class is for.** `trash/` is the whole of the undo this product
 * has: `remove()` puts two cards there, `StorageCleaner.sweep` puts whole
 * folders there for the cleanup command and for `forgetClosedTerminals`, and the
 * reconciler puts presence files there. Every one of those acts was written as
 * reversible on the strength of "the folder is still in the trash" -- and the
 * only hand that could reverse one belonged to a person who knew where the store
 * was, which of two dozen stamped folders held their record, and which
 * directory to drag it into.
 *
 * **IT COPIES AND THEN REMOVES. IT DOES NOT MOVE.** That is the single decision
 * this file exists to hold, and the reason is the asymmetry: a return that fails
 * half way through a MOVE has spent the copy in the trash without putting the
 * record back, which is the one undo there was. A return that fails half way
 * through a COPY has spent some disk. So the copy in the trash is taken away
 * only after every file has been proved to be at its destination, and a removal
 * that then fails is reported rather than treated as a failure of the return.
 *
 * **It writes nothing over anything.** Every destination is checked before the
 * first byte is copied, and each file is copied with `COPYFILE_EXCL` so that the
 * check and the act cannot be separated by another window. A record that is in
 * the store NOW is a record somebody is using, and the trash is not entitled to
 * overwrite it -- it is entitled to say so.
 */
export class TrashStore {
  constructor(private readonly _options: TrashStoreOptions) {}

  /**
   * What is in the trash, newest batch first.
   *
   * Newest first because of what the list is for: the record a person is looking
   * for is nearly always the one that went in last. Within a batch the names
   * sort, so two readings of one trash agree.
   *
   * Only batches this build made itself (`isTrashBatchName`), the same rule the
   * retention pass follows: a folder somebody put in there is theirs, and
   * offering to move it into `terminals/` would be this build acting on a
   * person's own backup.
   *
   * Answers `[]` for a store with no `trash/` at all rather than failing: a
   * profile where nothing was ever thrown away is not a fault.
   */
  public async list(): Promise<readonly TrashItem[]> {
    const { layout } = this._options;
    const found: TrashItem[] = [];

    const batches = [...(await this._directoriesIn(layout.trashDir))].filter(isTrashBatchName).sort();
    for (const batch of batches.reverse()) {
      for (const name of [...(await this._directoriesIn(layout.trashBatchNamed(batch)))].sort()) {
        if (isDiscardedOwnersArea(name)) {
          found.push(...(await this._ownerItems(batch)));
          continue;
        }
        const item = await this._terminalItem(batch, name);
        if (item !== null) {
          found.push(item);
        }
      }
    }
    return found;
  }

  /**
   * Puts one thing back where it came from, and takes the copy out of the trash
   * once it is proved to be there.
   *
   * The paths are formed again from the batch and the name rather than taken off
   * the item, so that an item held since the last listing cannot address
   * anything the layout would not address itself.
   *
   * Throws `NotFoundError` when the trash no longer holds it -- the retention
   * pass may have been through, or another window may have put it back already
   * -- and `ConflictError` when something is at the destination. Neither leaves
   * anything half done: both are decided before the first byte moves.
   */
  public async restore(item: TrashItem): Promise<TrashRestoreOutcome> {
    const { logger } = this._options;
    const legs = await this._legsFor(item);
    await this._refuseWhatIsInTheWay(legs);

    for (const leg of legs) {
      await mkdir(dirname(leg.to), { recursive: true, mode: STORAGE_DIRECTORY_MODE });
      // `COPYFILE_EXCL` rather than a plain copy, so that the check above and
      // the write here cannot be parted by another window: this fails rather
      // than overwrites.
      await copyFile(leg.from, leg.to, constants.COPYFILE_EXCL);
    }
    await this._proveItArrived(legs);

    const removed = await this._dropTheCopy(item);
    logger.info('a record was brought back from the trash', {
      batch: item.batch,
      name: item.name,
      form: item.form,
      restoredTo: this._homeOf(item),
      files: legs.map((leg) => leg.relative),
      trashCopyRemoved: removed,
    });
    return {
      restoredTo: this._homeOf(item),
      files: legs.map((leg) => leg.relative),
      trashCopyRemoved: removed,
    };
  }

  /** Where one thing in the trash goes back to. Formed by the layout, which checks. */
  private _homeOf(item: TrashItem): string {
    const { layout } = this._options;
    return item.form === 'owner-file'
      ? layout.ownerFileNamed(item.name)
      : layout.terminalDirNamed(item.name);
  }

  /** Where one thing in the trash lies now. Formed the same way, for the same reason. */
  private _restingPlaceOf(item: TrashItem): string {
    const { layout } = this._options;
    return item.form === 'owner-file'
      ? join(layout.discardedOwnersDir(item.batch), item.name)
      : join(layout.trashBatchNamed(item.batch), item.name);
  }

  /**
   * Every file that has to travel, the record LAST.
   *
   * The order is the same reasoning `FileTerminalRepository` writes a record by,
   * run in this direction: `record.json` is what makes a terminal appear in
   * every list again, so nothing may be able to see it until the history and the
   * settings it refers to are already there. A return dropped half way then
   * leaves a directory holding no readable record -- which every list in this
   * build passes over in silence and `StorageCleaner.strays` collects -- rather
   * than a row wearing a history that never arrived.
   */
  private async _legsFor(item: TrashItem): Promise<readonly Leg[]> {
    const from = this._restingPlaceOf(item);
    const to = this._homeOf(item);

    if (item.form === 'owner-file') {
      await this._requireFile(from);
      return [{ from, to, relative: item.name }];
    }

    const relatives = await this._filesUnder(from);
    if (relatives.length === 0) {
      throw new NotFoundError('the trash no longer holds anything under that name', {
        details: { path: from },
      });
    }
    const record = relatives.filter((relative) => relative === RECORD_FILE_NAME);
    const rest = relatives.filter((relative) => relative !== RECORD_FILE_NAME).sort();
    return [...rest, ...record].map((relative) => ({
      from: join(from, relative),
      to: join(to, relative),
      relative,
    }));
  }

  /**
   * Refuses the whole return if anything is already at a destination.
   *
   * Before the first byte, and over every file rather than the first one: a
   * refusal half way through would be a return that had already written into the
   * store and then stopped.
   *
   * A destination whose PARENT is a file answers `ENOTDIR` here and is left to
   * the copy, which reports the file system's own error about the real
   * obstruction rather than this one's guess at it.
   */
  private async _refuseWhatIsInTheWay(legs: readonly Leg[]): Promise<void> {
    for (const leg of legs) {
      if (await this._exists(leg.to)) {
        throw new ConflictError(
          'something is already where this would go, so nothing was brought back',
          { details: { path: leg.to } }
        );
      }
    }
  }

  /**
   * That every file is at its destination, whole, before anything is removed.
   *
   * This is the step the whole class is arranged around: the copy in the trash
   * is the only way back, so it is spent only against a destination that has
   * been READ rather than against a `copyFile` that did not throw. The size is
   * what can be checked without holding two files in memory, and it is the check
   * that catches the failure this is really about -- a write that stopped part
   * way through.
   */
  private async _proveItArrived(legs: readonly Leg[]): Promise<void> {
    for (const leg of legs) {
      const [was, now] = [await stat(leg.from), await stat(leg.to)];
      if (was.size !== now.size) {
        throw new StorageError(
          'a file did not arrive whole, so the copy in the trash was left where it is',
          { details: { from: leg.from, to: leg.to, was: was.size, now: now.size } }
        );
      }
    }
  }

  /**
   * Takes the copy out of the trash, and says whether it went.
   *
   * A failure here is a warning and not a throw, and the direction of the
   * mistake is the reason: the record is back, which is what was asked for, and
   * what is left is a duplicate the retention will take away by itself. Turning
   * that into a thrown error would tell a person their return failed when it did
   * not.
   */
  private async _dropTheCopy(item: TrashItem): Promise<boolean> {
    const from = this._restingPlaceOf(item);
    try {
      await rm(from, { recursive: true, force: true });
    } catch (cause: unknown) {
      this._options.logger.warn(
        'a record was brought back, but its copy could not be taken out of the trash',
        { path: from, cause }
      );
      return false;
    }
    await this._pruneEmpty(item);
    return true;
  }

  /**
   * Removes what the return has just emptied, deepest first.
   *
   * `rmdir` and not a listing then a decision: it removes a directory only if it
   * is empty, so a batch that still holds another record refuses and that
   * refusal IS the answer. Which is also why nothing here is reported -- an
   * empty batch left standing would be a claim that something is still in there.
   */
  private async _pruneEmpty(item: TrashItem): Promise<void> {
    const { layout } = this._options;
    const deepest = item.form === 'owner-file' ? [layout.discardedOwnersDir(item.batch)] : [];
    for (const path of [...deepest, layout.trashBatchNamed(item.batch)]) {
      try {
        await rmdir(path);
      } catch {
        // It holds something else. That is the answer, not a fault.
        return;
      }
    }
  }

  private async _ownerItems(batch: string): Promise<readonly TrashItem[]> {
    const { layout } = this._options;
    const dir = layout.discardedOwnersDir(batch);
    const found: TrashItem[] = [];
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (!child.isFile()) {
        continue;
      }
      found.push({
        batch,
        name: child.name,
        form: 'owner-file',
        from: join(dir, child.name),
        to: layout.ownerFileNamed(child.name),
        files: [child.name],
        displayName: null,
      });
    }
    return found.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * One discarded terminal, or `null` for a name this store could not address.
   *
   * `null` rather than a throw: a name the layout refuses is one entry a person
   * cannot be offered, and refusing to draw the WHOLE list over it would take
   * away the way back to everything else in the trash.
   */
  private async _terminalItem(batch: string, name: string): Promise<TrashItem | null> {
    const { layout, logger } = this._options;
    const from = join(layout.trashBatchNamed(batch), name);
    let to = '';
    try {
      to = layout.terminalDirNamed(name);
    } catch (cause: unknown) {
      logger.warn('something in the trash is under a name that cannot be put back', {
        path: from,
        cause,
      });
      return null;
    }
    return {
      batch,
      name,
      // Read now rather than remembered: which of the two forms this is depends
      // on whether the terminal's own folder is still in the store, and that is
      // a fact about the store rather than about the act that filled the trash.
      form: (await this._exists(to)) ? 'record-only' : 'whole-folder',
      from,
      to,
      files: await this._filesUnder(from),
      displayName: await this._nameWrittenIn(from),
    };
  }

  /**
   * The name a person gave the terminal, read out of the copy in the trash.
   *
   * Best effort by design, and `null` is a legitimate answer: what the cleanup
   * sweeps includes directories no record could be read from at all, which is
   * precisely why it can reach them. A list that refused to draw a row it could
   * not name would hide exactly those.
   */
  private async _nameWrittenIn(from: string): Promise<string | null> {
    try {
      const raw = await readFile(join(from, RECORD_FILE_NAME), 'utf8');
      return asString(asRecord(asRecord(JSON.parse(raw))?.metadata)?.displayName);
    } catch {
      return null;
    }
  }

  /** Every file under a directory, relative to it and sorted, deepest included. */
  private async _filesUnder(dir: string, prefix = ''): Promise<readonly string[]> {
    const found: string[] = [];
    for (const child of await this._entriesIn(dir)) {
      const relative = prefix === '' ? child.name : join(prefix, child.name);
      if (child.isDirectory()) {
        found.push(...(await this._filesUnder(join(dir, child.name), relative)));
        continue;
      }
      if (child.isFile()) {
        found.push(relative);
      }
    }
    return found.sort();
  }

  private async _requireFile(path: string): Promise<void> {
    if (!(await this._exists(path))) {
      throw new NotFoundError('the trash no longer holds that file', { details: { path } });
    }
  }

  private async _exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async _directoriesIn(path: string): Promise<readonly string[]> {
    return (await this._entriesIn(path)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  /**
   * What one place in the store holds, or nothing when the place is not there.
   *
   * Absence is not a failure -- `trash/` is made by the first thing that throws
   * something away -- and everything else is left to the caller, which is what a
   * listing that could not be trusted should do.
   */
  private async _entriesIn(path: string): Promise<readonly Dirent[]> {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (cause: unknown) {
      if ((cause as { readonly code?: unknown }).code !== 'ENOENT') {
        throw cause;
      }
      return [];
    }
  }
}
