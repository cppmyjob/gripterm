import { watch as watchDirectory } from 'node:fs';
import { isJournalPath } from './storage-layout';
import type { Disposable } from '../../domain/ports/disposable';
import type { Logger } from '../../domain/ports/logger';
import type { RepositoryListener } from '../../domain/repositories/terminal-repository';
import type { Scheduler } from '../../domain/ports/scheduler';
import type { StorageLayout } from './storage-layout';

/**
 * How long a burst is collected before the listeners are told to re-read.
 *
 * Short enough that a person does not perceive it and long enough that one
 * write -- which is three files and, measured, several callbacks -- costs one
 * re-read. [П]
 */
export const DEFAULT_DEBOUNCE_MS = 200;

/** A directory being watched, as this module needs it. */
export interface DirectoryHandle {
  readonly close: () => void;
}

export interface DirectoryEvents {
  /** `null` means the platform lost a batch and cannot say what was in it. */
  readonly onChange: (filename: string | null) => void;
  readonly onError: (cause: unknown) => void;
}

/**
 * Attaching to one directory, as a function.
 *
 * Injected for the same reason `SignalProbe` is in `FileOwnerPresence`: the
 * rules worth testing here are about WHAT IS DONE with a platform event -- a
 * lost batch, a journal path, a storm -- and none of them can be provoked
 * reliably through a real file system. The platform's own answer is measured
 * separately, by a test that writes a real file into a real directory.
 */
export type DirectoryWatch = (path: string, events: DirectoryEvents) => DirectoryHandle;

/**
 * What the platform called the thing that changed, or `null` for "no idea".
 *
 * Node types the name as `string | Buffer | null`, and anything that is not a
 * string is treated exactly like a lost batch: a name we cannot read is a name
 * we cannot filter, and the safe reading of an unfilterable event is "re-read
 * everything".
 */
export function watchedName(filename: string | Buffer | null): string | null {
  return typeof filename === 'string' ? filename : null;
}

/** The real thing: one recursive watcher per root. */
export const nodeDirectoryWatch: DirectoryWatch = (path, events) => {
  // `recursive` is not an optimisation: the records live two levels below the
  // root, and without it this would report only that a subdirectory appeared
  // (§4.8).
  const watcher = watchDirectory(path, { recursive: true });
  watcher.on('change', (_event: string, filename: string | Buffer | null) => {
    events.onChange(watchedName(filename));
  });
  watcher.on('error', events.onError);
  return {
    close: (): void => {
      watcher.close();
    },
  };
};

export interface RepositoryWatcherOptions {
  readonly layout: StorageLayout;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Defaults to `DEFAULT_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
  /** Defaults to the platform. A test hands in its own. */
  readonly watch?: DirectoryWatch;
}

/**
 * One root's traffic: who is waiting for it, and the wait that collapses a burst
 * into one wake.
 *
 * There are two of these and not one because the two roots answer two different
 * questions at two different rates -- see `watchPresence`.
 */
interface Channel {
  readonly listeners: Set<RepositoryListener>;
  pending: Disposable | null;
}

function subscribe(channel: Channel, listener: RepositoryListener): Disposable {
  channel.listeners.add(listener);
  return {
    dispose: (): void => {
      channel.listeners.delete(listener);
    },
  };
}

/**
 * What makes a change in ANOTHER window visible in this one, without polling.
 *
 * Two roots and not one: `terminals/`, and `owners/` as well. Without the second,
 * the death of another window would only reach this one through the reconciler's
 * thirty-second sweep (M2.12), and П4 asks for the list to be right without
 * polling.
 *
 * The signal carries no delta, and that is a measurement rather than a taste.
 * libuv's directory-watcher buffer on Windows is 4096 bytes, and when it
 * overflows the whole lost batch arrives as ONE event with no name at all --
 * reached, on paths of exactly our shape, at about twenty files. So an
 * implementation that deduplicated by name would have to drop the nameless
 * event, and would then lose changes in proportion to how many terminals are
 * open, which is to say exactly when the product is being used. Hence: no names
 * leave this class, and the deduplication the plan asks for IS the debounce --
 * a burst of any size becomes one "read it again".
 *
 * The debounce deliberately does not restart on each event. A resetting one
 * would never fire at all under the storm this project has already measured
 * (122 021 events in 1.5 s when a watched directory is deleted), and going quiet
 * exactly while the store is changing most is the failure this class exists to
 * prevent. As written, the first event of a burst sets the deadline and the rest
 * are absorbed, so progress is guaranteed at one re-read per window.
 *
 * Deleting or moving a watched directory closes the watcher FIRST (§4.8): on
 * this platform the deletion of a watched root storms without ever emitting an
 * error, and its rename goes through in complete silence with the watcher
 * following the directory to its new path. Neither is detectable from here,
 * which is why it is a rule for the caller and not a branch in this file.
 */
export class RepositoryWatcher implements Disposable {
  private readonly _records: Channel = { listeners: new Set(), pending: null };
  private readonly _presence: Channel = { listeners: new Set(), pending: null };
  private readonly _roots = new Map<string, DirectoryHandle>();
  private _stopped = false;

  constructor(private readonly _options: RepositoryWatcherOptions) {}

  /**
   * Attaches to both roots. Call once; a second call is ignored rather than
   * doubling the handles.
   *
   * Separate from the constructor because it is the one thing here that touches
   * the file system, and because the caller has to be able to say WHEN -- after
   * the migrator has made the directories, and again after the storage path has
   * changed.
   */
  public start(): void {
    if (this._stopped || this._roots.size > 0) {
      return;
    }
    this._attach(this._options.layout.terminalsDir, this._records);
    this._attach(this._options.layout.ownersDir, this._presence);
  }

  /** What the LIST is drawn from: the records, and nothing about who holds them. */
  public watch(listener: RepositoryListener): Disposable {
    return subscribe(this._records, listener);
  }

  /**
   * Who is out there: `owners/`, which is a different question and a different
   * cadence.
   *
   * Separate from `watch` because of the pulse. Every window rewrites its own
   * presence file every ten seconds (`HEARTBEAT_INTERVAL_MS`), so this signal
   * fires W times per round in every one of W windows -- while the list it used
   * to wake learns nothing from it at all, `readAll()` never having asked
   * presence a question. Measured before the split, at four windows and forty
   * records: sixteen full reads of the whole store per pulse round, 96 a minute,
   * on a machine where nobody was doing anything.
   */
  public watchPresence(listener: RepositoryListener): Disposable {
    return subscribe(this._presence, listener);
  }

  /** Final: a disposed watcher does not start again, and a late event finds nobody. */
  public dispose(): void {
    this._stopped = true;
    for (const channel of [this._records, this._presence]) {
      channel.pending?.dispose();
      channel.pending = null;
      channel.listeners.clear();
    }
    for (const handle of this._roots.values()) {
      handle.close();
    }
    this._roots.clear();
  }

  private _attach(path: string, channel: Channel): void {
    const attach = this._options.watch ?? nodeDirectoryWatch;
    try {
      this._roots.set(
        path,
        attach(path, {
          onChange: (filename): void => {
            this._onChange(filename, channel);
          },
          onError: (cause): void => {
            this._onBlind(path, channel, cause);
          },
        })
      );
    } catch (cause: unknown) {
      // Measured on this machine: watching a directory that is not there throws
      // ENOENT synchronously. Reported and survived rather than thrown, because
      // one unwatchable root still leaves the other one working, and a window
      // that refused to activate over it would show nothing at all.
      this._options.logger.error(
        'a store directory could not be watched, so changes other windows make there will not be seen',
        { path, cause }
      );
    }
  }

  /**
   * One platform event, on the root it arrived at.
   *
   * The root decides who hears it, and that is the whole of the rule: a name
   * under `terminals/` is news for the list, a name under `owners/` is news
   * about who is out there, and a LOST BATCH is both of those about one root --
   * so it goes to that root's listeners and to nobody else's. Before the split
   * every event of either kind woke everybody.
   */
  private _onChange(filename: string | null, channel: Channel): void {
    if (filename !== null && isJournalPath(filename)) {
      return;
    }
    this._schedule(channel);
  }

  /**
   * The watcher for one root has failed. Said loudly, and not retried.
   *
   * A retry loop around a watcher that has already failed is a promise this
   * milestone cannot keep -- there is no measurement behind any particular
   * interval, and a silent reattachment that also fails would look like working
   * observation. The window is told; reloading it, or changing
   * `gripterm.storage.path`, builds a new watcher.
   *
   * One re-read is still asked for: it is the last honest act of a watcher going
   * blind, and it makes the list right as of the moment sight was lost rather
   * than as of whenever the last event happened to arrive.
   */
  private _onBlind(path: string, channel: Channel, cause: unknown): void {
    this._options.logger.error(
      'a store directory stopped reporting changes; this window will not see other windows there until it is reloaded',
      { path, cause }
    );
    this._schedule(channel);
  }

  private _schedule(channel: Channel): void {
    if (this._stopped || channel.pending !== null) {
      return;
    }
    channel.pending = this._options.scheduler.after(
      this._options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      () => {
        channel.pending = null;
        this._notify(channel);
      }
    );
  }

  private _notify(channel: Channel): void {
    for (const listener of channel.listeners) {
      try {
        listener();
      } catch (cause: unknown) {
        // This runs from a timer, so a throw that escaped would land nowhere a
        // caller could catch it -- and would take the remaining listeners with
        // it. The subscriber that failed is named as far as it can be; the
        // others still get their signal.
        this._options.logger.error('a listener failed while reacting to a change in the store', {
          cause,
        });
      }
    }
  }
}
