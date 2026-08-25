import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictError, NotFoundError } from '../../domain/errors/gripterm-error';
import { OwnerId } from '../../domain/entities/owner-id';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';
import { TerminalId } from '../../domain/entities/terminal-id';
import { asRecord, asString } from '../../domain/json/json-readers';
import { decodeEntry, encodeObserved, encodeRecord } from './record-codec';
import { moveAtomic } from './atomic-file';
import { readJsonFile, writeJsonFile } from './json-file';
import type { Clock } from '../../domain/ports/clock';
import type { Disposable } from '../../domain/ports/disposable';
import type { JsonRead } from './json-file';
import type { Logger } from '../../domain/ports/logger';
import type { OwnerPresence } from '../../domain/ports/owner-presence';
import type { OwnerRef } from '../../domain/entities/owner-ref';
import type { StorageLayout } from './storage-layout';
import type { TerminalEntry } from '../../domain/entities/terminal-entry';
import type {
  AdoptOptions,
  RepositoryListener,
  TerminalRepository,
} from '../../domain/repositories/terminal-repository';

/**
 * The file that says "this terminal is being adopted right now".
 *
 * Its name is deliberately not `.lock`, and the difference is which question
 * gets asked first. A lock waits out a timeout. This asks whether the window
 * that laid the claim is still there, and takes the claim over at once when it
 * is not. The expiry below is what happens when that question has no answer --
 * not what happens first. See `_claim` and `_takeOverOrRefuse`.
 */
const CLAIM_FILE = 'adopting.json';

/**
 * How long a claim stays a claim once nothing can be established about whoever
 * laid it. [П]
 *
 * A claim covers a handful of local file operations -- one read of the record,
 * one comparison, two writes -- so a minute is three or four orders of
 * magnitude above the work it protects, and nothing still doing that work can
 * reach it. It is the same minute the store already spends deciding that a
 * window which has gone quiet is no longer to be believed
 * (`FRESH_HEARTBEAT_MS`), and it is written out here rather than imported from
 * there because they are not the same quantity: one is about heartbeats and
 * the other about file operations, and either must be able to move without
 * dragging the other along.
 *
 * **This is not the stale window §4.8 turned `proper-lockfile` down over.**
 * That objection was that a crashed editor blocks adoption for two minutes,
 * and it still stands: a claim whose holder is established dead is taken over
 * immediately, with nothing waited out. What is below is reached only where
 * liveness has no answer to give at all.
 */
export const CLAIM_EXPIRY_MS = 60_000;

export interface FileTerminalRepositoryOptions {
  readonly layout: StorageLayout;
  /** This activation. Everything written carries it, and nothing else may be written. */
  readonly owner: OwnerRef;
  /** Answers whether the CURRENT owner of a record is still there. */
  readonly presence: OwnerPresence;
  /**
   * Stamps the trash directory a discarded record goes to, and reads the age of
   * an adoption claim against its file's `mtime` (`CLAIM_EXPIRY_MS`).
   */
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * The base as a directory of files, shared by every window on this machine.
 *
 * Two rules from §4.8 are carried here rather than assumed:
 *
 *   * **One writer.** `write` refuses an entry this window does not own -- by
 *     the repository, not by convention, so a caller cannot forget.
 *   * **Adoption is a compare-and-swap on an atomic file-system primitive.** A
 *     read-then-write pair would be a TOCTOU: two windows read the same
 *     revision, both pass the check, and both start `claude --resume` on one
 *     conversation.
 *
 * A record that cannot be read is ISOLATED, not fatal: it is logged with its
 * path and its neighbours are still returned. The alternative -- one malformed
 * file emptying the list -- is a defect this project has already met in the
 * CLI's own store.
 */
export class FileTerminalRepository implements TerminalRepository {
  private readonly _listeners = new Set<RepositoryListener>();
  /**
   * What this window last wrote into each `record.json`, serialised.
   *
   * Memory rather than a read, and it is the single-writer rule cashed in: while
   * this window is alive nobody else may write these files, so what we put there
   * is what is there. See `_store` for what it is for.
   *
   * The one shape it can be wrong about is a record taken from a live window by
   * a FORCED adoption (`AdoptOptions.force`), which is a person saying they have
   * looked and this window is gone. It is then wrong about a record it should
   * not be writing at all.
   */
  private readonly _records = new Map<string, string>();

  constructor(private readonly _options: FileTerminalRepositoryOptions) {}

  public async readOwn(ownerId: OwnerId): Promise<readonly TerminalEntry[]> {
    const all = await this.readAll();
    return all.filter((entry) => entry.owner.ownerId.equals(ownerId));
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    const entries: TerminalEntry[] = [];
    for (const directory of await this._terminalDirectories()) {
      const entry = await this._read(directory);
      if (entry !== null) {
        entries.push(entry);
      }
    }
    return entries;
  }

  public async write(entry: TerminalEntry): Promise<void> {
    if (!entry.owner.ownerId.equals(this._options.owner.ownerId)) {
      throw new ConflictError('only the owning window may write an entry', {
        details: { terminalId: entry.terminalId.value, owner: entry.owner.ownerId.value },
      });
    }
    await this._store(entry);
    this._notify();
  }

  /**
   * Takes over a record whose owner is gone.
   *
   * The order of the checks is the design and not an accident. The revision is
   * compared FIRST, so that a caller working from a stale read is turned away
   * before anything is created; liveness comes next, because it is the
   * expensive question and the one that can say `unknown`; the claim is last,
   * and everything after it is done while holding it -- including READING THE
   * RECORD AGAIN. Without that second read the whole primitive would be
   * decorative: the window that won the claim would still be acting on a
   * revision it read before the race.
   *
   * **`options` reaches BOTH questions, which until Ш7в it did not.** It got as
   * far as the owner of the record and stopped at the claim, so a person who
   * had looked and knew the other window was gone could get past the first
   * refusal and not the second -- and the second had no expiry either, which
   * left them no way through at all (S48).
   */
  public async adopt(
    id: TerminalId,
    expected: number,
    options: AdoptOptions = {}
  ): Promise<TerminalEntry> {
    const before = await this._require(id);
    assertRevision(id, expected, before.revision);
    await this._assertAdoptable(before.owner.ownerId, options);

    const claim = await this._claim(id, options);
    try {
      const current = await this._require(id);
      assertRevision(id, expected, current.revision);

      const adopted = current.adoptedBy(this._options.owner);
      await this._store(adopted);
      this._notify();
      return adopted;
    } finally {
      await claim.release();
    }
  }

  /**
   * Puts the record in the trash, and deliberately does NOT destroy anything.
   *
   * **It moves rather than deletes**, and that is the rule of §I.3 rather than a
   * kindness: `record.json` holds the task, the notes and the tags, which are
   * the one thing in this store nothing can rebuild, and a confirmation dialog
   * is not a rollback -- it is a question asked before the point of no return,
   * not a way back from it. `trash/<stamp>/<terminalId>/` holds the two files
   * under their own names, so undoing a deletion is moving a directory back and
   * needs neither this build nor any tool. M2.15 inherited the shape and added
   * the daily sweep that keeps it from growing forever.
   *
   * **The journal, the settings file and the directory stay where they are.**
   * The journal is the one artefact no later version can go back for (§10.1а),
   * and a command that removes a row from a list has no business destroying it.
   * Nor is the Claude Code conversation touched, here or anywhere else in this
   * codebase: it lives in the CLI's own store, and deleting our record of a
   * terminal is not a decision about anybody's conversation (M2.7).
   *
   * **The record goes FIRST and the snapshot last, which is the opposite of the
   * order `_store` writes them in -- and the same reasoning, run in the
   * direction this method actually moves (Ш7б, defect 8).** In both methods the
   * record is the commit point, because it is the half nothing can rebuild.
   * Writing, that means the record LAST: it is what makes the new state real.
   * Removing, it means the record FIRST: taking it away is what makes the
   * removal real, and everything after that is tidying a cache.
   *
   * Until 2026-08-25 this method borrowed `_store`'s order instead of its
   * reasoning, and that inverted it. A machine stopping between the two renames
   * then left `record.json` here with no `observed.json` beside it -- which the
   * codec does not merely absorb: it INVENTS a snapshot for it, `degraded`,
   * stamped with the record's own creation time, and hands it back looking like
   * something we saw. So a record a person asked to delete came back as a row,
   * wearing an observation nobody made, and the restore planner read that
   * invented timestamp as evidence that its conversation was from a previous
   * life and started it again. Stopping in the middle now leaves the
   * irreplaceable half safe in the trash and a directory holding no record,
   * which `_read` passes over in silence and `StorageCleaner.strays` collects.
   *
   * A snapshot that cannot be moved at all does not stop the deletion: it is a
   * cache, its loss costs nothing, and refusing to delete a record over it would
   * leave the person with a row they asked twice to be rid of.
   *
   * One consequence, named rather than discovered: a record that cannot be READ
   * cannot be removed here either, because `_require` cannot find it. Such a
   * record is invisible in the list as well, so nothing is stuck in front of
   * anybody. It is `StorageCleaner.strays` that reaches it (M2.15): that pass
   * works on directories and asks only whether a record could be read at all --
   * which is also what collects the directory THIS method leaves behind, with
   * the journal and the settings still in it.
   */
  public async remove(id: TerminalId): Promise<void> {
    await this._require(id);
    const { layout } = this._options;
    const at = this._options.clock.now();

    await mkdir(layout.discardedTerminalDir(at, id), {
      recursive: true,
      mode: STORAGE_DIRECTORY_MODE,
    });
    await moveAtomic(layout.recordFile(id), layout.discardedRecordFile(at, id));
    await this._discardObserved(at, id);

    // Forgotten here as well, or a record written again under the same id and
    // the same content -- which is what restoring one looks like -- would be
    // recognised as already on disk and never written back.
    this._records.delete(id.value);
    this._options.logger.info('a terminal record was moved to the trash', {
      terminalId: id.value,
      path: layout.discardedTerminalDir(at, id),
    });
    this._notify();
  }

  /**
   * Local listeners only, for now.
   *
   * A change made in ANOTHER window does not reach this yet -- that is M2.5,
   * where a recursive `fs.watch` over `terminals/` and `owners/` is added behind
   * this same signal. Said plainly because the port's name promises more than
   * this milestone delivers, and a promise nobody wrote down is the kind that
   * gets believed.
   */
  public watch(listener: RepositoryListener): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  /** See `remove`: the snapshot is a cache, so its move is allowed to fail. */
  private async _discardObserved(at: Date, id: TerminalId): Promise<void> {
    const { layout } = this._options;
    try {
      await moveAtomic(layout.observedFile(id), layout.discardedObservedFile(at, id));
    } catch (cause: unknown) {
      this._options.logger.info('a discarded record left its observed snapshot behind', {
        terminalId: id.value,
        cause,
      });
    }
  }

  private async _terminalDirectories(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this._options.layout.terminalsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (cause: unknown) {
      // No `terminals/` at all is an empty base, not a failure: the migrator
      // creates it at activation, and a test or a fresh profile may reach this
      // first.
      this._options.logger.info('the store holds no terminals yet', { cause });
      return [];
    }
  }

  /** `null` for a directory that holds no readable record -- reported, never thrown. */
  private async _read(directoryName: string): Promise<TerminalEntry | null> {
    // The directory NAME is the id, so a name that is not one belongs to
    // something that is not ours. Validating it here also means every path
    // below comes from the layout rather than from `readdir`.
    const id = TerminalId.tryFromString(directoryName);
    if (id === null) {
      return null;
    }

    const path = this._options.layout.recordFile(id);
    const record = await readJsonFile(path);
    if (record.kind === 'absent') {
      // Normal, and the reason there is no warning: M1 left directories holding
      // nothing but `settings.json`, and a terminal being created has a
      // directory before it has a record.
      return null;
    }
    if (record.kind === 'unreadable') {
      this._options.logger.warn('a terminal record could not be read and was skipped', {
        path,
        reason: record.reason,
      });
      return null;
    }

    const observed = await readJsonFile(this._options.layout.observedFile(id));
    const decoded = decodeEntry(record.value, observed.kind === 'value' ? observed.value : undefined);
    if (decoded.kind === 'broken') {
      this._options.logger.warn('a terminal record was malformed and was skipped', {
        path,
        reason: decoded.reason,
      });
      return null;
    }
    if (decoded.observed.kind === 'recovered') {
      this._options.logger.info('a terminal came back without its observed state', {
        path,
        reason: decoded.observed.reason,
      });
    }
    return decoded.entry;
  }

  private async _require(id: TerminalId): Promise<TerminalEntry> {
    const entry = await this._read(id.value);
    if (entry === null) {
      throw new NotFoundError('no readable entry with that terminal id', {
        details: { terminalId: id.value },
      });
    }
    return entry;
  }

  /**
   * Writes both halves, the record LAST -- and the record only when it moved.
   *
   * The order first. A crash between the two leaves the observed snapshot ahead
   * of the record, which the codec absorbs -- it is a cache and is allowed to be
   * wrong. The other order would leave a record pointing at a snapshot that
   * never arrived, and the reader would have no way to tell that from a snapshot
   * legitimately lost.
   *
   * Then the skip, which is the other half of M2.6. The observed half is written
   * on every debounced pass; the record half is the same bytes on almost all of
   * them, and writing a file whose content did not change is a no-op with three
   * side effects and no benefit: every other window's watcher fires and answers
   * by re-reading the whole base; a reader in one of them meets our `rename` and
   * pays the retry ladder for it (measured `EPERM`, §2.1a); and a crash mid-write
   * leaves a scratch file behind. It is also the file holding the task and the
   * notes, which is the one thing in this store nothing can rebuild, so the
   * asymmetry runs the right way: skipping costs nothing, writing costs a little
   * every time, and the little is paid a few thousand times an hour.
   */
  private async _store(entry: TerminalEntry): Promise<void> {
    const { layout } = this._options;
    const id = entry.terminalId;
    await mkdir(layout.terminalDir(id), { recursive: true, mode: STORAGE_DIRECTORY_MODE });
    await writeJsonFile(layout.observedFile(id), encodeObserved(entry.observed));

    const record = encodeRecord(entry);
    const written = JSON.stringify(record);
    if (written === this._records.get(id.value)) {
      return;
    }
    await writeJsonFile(layout.recordFile(id), record);
    // After the write, never before: a record remembered as stored and then not
    // stored would be skipped for as long as this window lives.
    this._records.set(id.value, written);
  }

  /**
   * Refuses to displace an owner who might still be there.
   *
   * `unknown` is refused as firmly as `live` and for a stronger reason: it is
   * what a window looks like after the machine wakes from sleep, and adopting
   * one starts a second `claude --resume` on a conversation that already has
   * one. `force` is the person saying they have looked.
   */
  private async _assertAdoptable(ownerId: OwnerId, options: AdoptOptions): Promise<void> {
    const liveness = await this._options.presence.livenessOf(ownerId);
    if (liveness === 'dead') {
      return;
    }
    if (liveness === 'unknown' && options.force === true) {
      return;
    }
    throw new ConflictError('the owner of this entry has not been established as gone', {
      details: { ownerId: ownerId.value, liveness },
    });
  }

  /**
   * The atomic primitive the compare-and-swap rests on: an exclusive create.
   *
   * Whoever's `open` with `wx` succeeds is the one adopting; everybody else gets
   * `EEXIST` and is turned away with a `ConflictError`, which is a caller's cue
   * to re-read rather than an error to show anyone.
   *
   * A claim left behind by a crash is resolved the way everything else in this
   * design is: by asking whether its owner is still alive. A claim held by a
   * dead owner is not a claim and is taken over -- at once, with no stale
   * window waited out, which is what §4.8 turned `proper-lockfile` down over:
   * its 120 seconds mean a crashed editor blocks adoption for two minutes.
   *
   * There IS an expiry since Ш7в, and it does not touch that. It is reached
   * only where the liveness question has no answer to give at all. See
   * `_takeOverOrRefuse` and `CLAIM_EXPIRY_MS`.
   */
  private async _claim(
    id: TerminalId,
    options: AdoptOptions
  ): Promise<{ release: () => Promise<void> }> {
    const path = join(this._options.layout.terminalDir(id), CLAIM_FILE);
    const mine = { ownerId: this._options.owner.ownerId.value, pid: process.pid };

    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify(mine), 'utf8');
      await handle.close();
    } catch (cause: unknown) {
      await this._takeOverOrRefuse(id, path, cause, options);
    }

    return {
      release: async (): Promise<void> => {
        await rm(path, { force: true });
      },
    };
  }

  /**
   * Called when the exclusive create did not succeed, for ANY reason.
   *
   * The reason is deliberately not branched on. `EEXIST` -- another window is
   * here -- is the one that matters, and every other refusal from the file
   * system leads to the same place by the same reasoning: we did not get the
   * claim, so we do not adopt. The cause travels on the error rather than
   * through a branch no test on this platform could reach.
   *
   * **Two questions are asked about the claim, and the second is Ш7в.** Whose
   * it is, and how old it is. Liveness answers for a holder established dead
   * and for nobody else: a holder that is merely `unknown`, a holder that is
   * plainly alive and simply never released what it took, and a claim file
   * nothing can be read out of are three states it has nothing to say about --
   * and "nothing to say" meant "refuse", which for a claim nobody is ever
   * coming back for meant refuse for ever. Those are the three, measured
   * 2026-08-24 and written down as S48, and the third has no other way out at
   * all: there is no holder in it to ask liveness about, so no window closing
   * and no machine rebooting will ever change the answer.
   *
   * **What age is allowed to cross and what it is not.** An expiry resolves an
   * ABSENCE of evidence; it does not overrule evidence. A claim nothing can be
   * attributed to, and one whose holder is `unknown`, are absences, and the
   * expiry takes them with nobody asked. A holder the store can see as `live`
   * is evidence that a window is running right now, so that one takes a person
   * as well -- and the expiry too, so that no automatic pass can ever displace
   * a window genuinely in the middle of the few file operations a claim covers.
   *
   * **`force` here is the same sentence it is in `_assertAdoptable`** -- a
   * person saying they have looked and that window is gone -- and it buys the
   * same thing: `unknown`, never `live` on its own. What Ш7в changed is only
   * that it arrives.
   */
  private async _takeOverOrRefuse(
    id: TerminalId,
    path: string,
    cause: unknown,
    options: AdoptOptions
  ): Promise<void> {
    const stale = await this._claimIsStale(path);
    const forced = options.force === true;
    const holder = holderOf(await readJsonFile(path));

    if (holder === null) {
      // A claim we cannot attribute is treated as held by somebody: refusing
      // costs the person one retry, while guessing "nobody" costs a second
      // `--resume`. One retry is the true price only while the file is young --
      // `open` with `wx` creates it and the write naming its holder follows, so
      // an unattributable claim is most often that instant, caught in the
      // middle. A file that STAYS unreadable charges that price on every
      // attempt for ever, and its age is the only fact anyone has left about it.
      if (stale) {
        await this._takeClaimOver(id, path, null, 'nothing could be read out of it and it is past its expiry');
        return;
      }
      throw new ConflictError('this entry could not be claimed for adoption', {
        cause,
        details: { terminalId: id.value },
      });
    }

    const liveness = await this._options.presence.livenessOf(holder);
    if (liveness === 'dead') {
      // The holder is gone. Taking the claim over is a plain overwrite: the
      // exclusive create has already told us we are not racing a live window,
      // and the record itself is still protected by the revision check that
      // follows.
      this._options.logger.info('an adoption claim left behind by a dead window was taken over', {
        terminalId: id.value,
        holder: holder.value,
      });
      await this._writeClaim(path);
      return;
    }
    if (liveness === 'unknown' && (forced || stale)) {
      const because = forced
        ? 'its window is there and silent, and a person asked for this record'
        : 'its window is there and silent, and the claim is past its expiry';
      await this._takeClaimOver(id, path, holder, because);
      return;
    }
    if (liveness === 'live' && forced && stale) {
      await this._takeClaimOver(
        id,
        path,
        holder,
        'a person asked for this record and the claim is past its expiry'
      );
      return;
    }

    throw new ConflictError('another window is adopting this entry right now', {
      details: { terminalId: id.value, holder: holder.value, liveness, stale },
    });
  }

  /**
   * Overwrites a claim nothing is using, and says in one sentence why.
   *
   * One message with the reason as a detail rather than three messages: a
   * person reading their log finds every takeover of this kind by one string,
   * and then reads which of the cases it was.
   */
  private async _takeClaimOver(
    id: TerminalId,
    path: string,
    holder: OwnerId | null,
    because: string
  ): Promise<void> {
    this._options.logger.info('an adoption claim nobody was using was taken over', {
      terminalId: id.value,
      holder: holder === null ? null : holder.value,
      because,
    });
    await this._writeClaim(path);
  }

  /** This window's claim, written over whatever was there. */
  private async _writeClaim(path: string): Promise<void> {
    await writeJsonFile(path, { ownerId: this._options.owner.ownerId.value, pid: process.pid });
  }

  /**
   * Whether a claim has lain there longer than any adoption could take.
   *
   * The age is the FILE's, from its `mtime`, and not a field written inside it.
   * The deciding reason is the third of three: a field is one more thing a
   * claim can be wrong about; the file system stamps `mtime` without being
   * asked; and a claim file nothing can be parsed out of still has one, which
   * is exactly the case where there is nothing else left to ask.
   *
   * An age that cannot be established at all -- the file went away between the
   * failed create and this read -- counts as fresh, which is the refusing side.
   * Whoever took it away has already let the next attempt through.
   *
   * A claim stamped in the FUTURE reads as fresh as well, by the same
   * arithmetic and on purpose: it means the wall clock moved, and a clock that
   * moved is not a reason to seize anything. What this store does about clocks
   * that jump is a separate question (Ш7г) and lives elsewhere.
   */
  private async _claimIsStale(path: string): Promise<boolean> {
    try {
      const { mtimeMs } = await stat(path);
      return this._options.clock.now().getTime() - mtimeMs >= CLAIM_EXPIRY_MS;
    } catch {
      return false;
    }
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

function assertRevision(id: TerminalId, expected: number, actual: number): void {
  if (actual !== expected) {
    throw new ConflictError('the entry moved while it was being adopted', {
      details: { terminalId: id.value, expected, actual },
    });
  }
}

/**
 * Who wrote a claim file, or `null` when that cannot be established.
 *
 * Every failure folds into `null` rather than throwing, and the caller treats
 * `null` as "somebody holds it": a claim file we cannot parse is still evidence
 * that another window was here, and the expensive mistake is to read nonsense
 * as nobody.
 */
function holderOf(read: JsonRead): OwnerId | null {
  if (read.kind !== 'value') {
    return null;
  }
  const claim = asRecord(read.value);
  if (claim === null) {
    return null;
  }
  const owner = asString(claim.ownerId);
  if (owner === null || owner.trim().length === 0) {
    return null;
  }
  return OwnerId.fromString(owner);
}
