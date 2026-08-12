import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { Scheduler } from '../ports/scheduler';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';
import type { TerminalRepository } from '../repositories/terminal-repository';

/**
 * How long a burst of events is collected before what it produced is written.
 *
 * The person's own window never waits for this -- the list is drawn from memory
 * -- so the only things it delays are what OTHER windows see and what would
 * survive a crash. Half a second keeps both inside "as good as live" for a human
 * reading a list, and it bounds a working terminal to two writes a second
 * instead of one per tool call. [П]
 *
 * It cannot be made much longer without cost, either: this window's write is
 * what wakes every other window's watcher, and each of those answers by reading
 * the whole base. Short debounce, storm of reads; long debounce, stale rows.
 */
export const DEFAULT_WRITE_DEBOUNCE_MS = 500;

/**
 * One terminal's next appointment with the disk.
 *
 * A union rather than an entry that may be `null`, because the two are not the
 * same operation and the difference must survive the queue: a record queued to
 * be stored and then deleted must reach the disk as a deletion, and a `null`
 * standing for "gone" is a value every later reader has to be told about.
 */
type PendingChange =
  | { readonly kind: 'store', readonly entry: TerminalEntry }
  | { readonly kind: 'discard', readonly terminalId: TerminalId };

export interface BaseWriterOptions {
  readonly repository: TerminalRepository;
  readonly registry: SessionRegistry;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Defaults to `DEFAULT_WRITE_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

/**
 * This window's writer: what it holds in memory, put where every window can see
 * it.
 *
 * The mirror of `BaseProjection`, and the half that makes the base a base
 * rather than a directory somebody else writes into. It subscribes to the
 * registry, so there is exactly one road from "something happened to a terminal"
 * to "it is on disk", and no caller has to remember to take it.
 *
 * **Two frequencies, and they are why there are two files (§4.8).** A record's
 * metadata -- its task, its notes, its name -- changes when a person changes it,
 * which is rarely; its observed state changes on every hook event, which during
 * a working turn is several a second. So:
 *
 *   * a change this window MADE (`transition === null`: a registration, a close,
 *     a note) is written at once. Debouncing something that rare buys nothing
 *     and pays for it in durability: a terminal created and not yet written is a
 *     terminal the next activation cannot restore, and `closedAt` that missed
 *     the disk is a conversation resurrected against the person's decision;
 *   * a change an EVENT made is collected and written on the debounce.
 *
 * The other half of the answer is in `FileTerminalRepository`: writing the
 * observed half never rewrites `record.json` unless its content actually moved.
 * Both halves are needed -- this one turns a burst into one write, that one
 * keeps the burst away from the file holding the only thing in this store that
 * nothing can rebuild.
 *
 * **A deletion travels the same road** (M2.7), which is what keeps it in order.
 * It replaces whatever store of that record was queued rather than racing it, so
 * a record edited and then thrown away in the same second cannot reach the disk
 * as an edit after it has reached it as a deletion.
 *
 * **The debounce does not restart on each change**, for the reason measured in
 * M2.5: a resetting one goes quiet exactly while things are happening fastest.
 * The first change of a burst sets the deadline and the rest are absorbed into
 * it, so progress is guaranteed at one pass per window.
 *
 * **A wholesale projection change is ignored, and that is not an omission.**
 * Those are other windows' records, and we are not their writer (§4.8). Writing
 * one back would also be a loop with no exit: our write wakes our own watcher,
 * the watcher re-reads the base, the re-read replaces the projection, and the
 * projection would ask us to write again.
 *
 * **A failed write is reported and not retried.** It is not lost work: the next
 * change to that terminal queues it again, and the state it would have written
 * is superseded rather than missing. A retry loop, by contrast, would meet a
 * full disk with one attempt every half second for the life of the window.
 *
 * **What comes out of all this is self-limiting**, which matters more than the
 * debounce interval does. One write is ever in flight, and what waits behind it
 * is one state per terminal rather than a queue of them -- so a store that has
 * become slow is written to less often instead of falling behind, and nothing
 * ever reaches the disk that a newer state has already replaced.
 */
export class BaseWriter implements Disposable {
  /** Terminals whose latest state has not reached the store yet, one per id. */
  private readonly _pending = new Map<string, PendingChange>();
  private _subscription: Disposable | null = null;
  private _timer: Disposable | null = null;
  private _writing = false;
  private _finished: Promise<void> = Promise.resolve();
  private _stopped = false;

  constructor(private readonly _options: BaseWriterOptions) {}

  /**
   * Starts listening, and takes what the registry already holds.
   *
   * The second part costs a loop and removes a rule somebody would otherwise
   * have to keep: that this must be composed before the first terminal is
   * registered. It is, today -- but "today" is the kind of ordering that a
   * refactor moves and no test notices.
   */
  public start(): void {
    if (this._stopped || this._subscription !== null) {
      return;
    }
    this._subscription = this._options.registry.subscribe((change) => {
      this._onChange(change);
    });
    for (const entry of this._options.registry.own()) {
      this._pending.set(entry.terminalId.value, { kind: 'store', entry });
    }
    void this._drain();
  }

  /**
   * Stops listening and writes what is left. Idempotent, and safe before
   * `start`.
   *
   * Awaited from `deactivate`, and that is the whole reason it is separate from
   * `dispose`: the last thing that happens to a terminal is its close event, and
   * a window that went without writing it leaves a record claiming to be
   * `working` on a tool that stopped running when the editor did.
   */
  public async stop(): Promise<void> {
    this._subscription?.dispose();
    this._subscription = null;
    await this._drain();
    this._stopped = true;
  }

  /** For `context.subscriptions`, which cannot await. The flush is in `stop`. */
  public dispose(): void {
    this._stopped = true;
    this._subscription?.dispose();
    this._subscription = null;
    this._disarm();
  }

  private _onChange(change: RegistryChange): void {
    switch (change.kind) {
      case 'projection':
        return;

      case 'removed':
        // At once, and never on the debounce. A person pressed delete and
        // confirmed it; a row that lingers in every other window for half a
        // second after that is a row they will click.
        this._pending.set(change.terminalId.value, {
          kind: 'discard',
          terminalId: change.terminalId,
        });
        void this._drain();
        return;

      case 'entry':
        this._pending.set(change.entry.terminalId.value, {
          kind: 'store',
          entry: change.entry,
        });
        if (change.transition === null) {
          void this._drain();
          return;
        }
        this._arm();
        return;
    }
  }

  private _arm(): void {
    if (this._timer !== null) {
      return;
    }
    this._timer = this._options.scheduler.after(
      this._options.debounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS,
      () => {
        this._timer = null;
        void this._drain();
      }
    );
  }

  private _disarm(): void {
    this._timer?.dispose();
    this._timer = null;
  }

  /**
   * Writes everything pending, one write at a time, and returns when the store
   * has caught up.
   *
   * Never two at once, and not for the cost of the second one: two writes of one
   * terminal can finish in the other order, and the older state would then be
   * the one left on disk with no event remaining to correct it. A caller
   * arriving while a pass is running is handed the running pass -- which is also
   * what makes `stop()` a flush rather than a race with one.
   */
  private async _drain(): Promise<void> {
    this._disarm();
    if (!this._writing) {
      this._writing = true;
      this._finished = this._run();
    }
    await this._finished;
  }

  /**
   * The flag is raised by the caller above and lowered HERE, synchronously,
   * inside the pass itself.
   *
   * It cannot be a promise that clears itself when it settles, and that was
   * found by a test rather than by reasoning: a pass with nothing to do never
   * suspends, so it would finish before the field naming it had been assigned,
   * and every change made in the rest of that tick -- a registration, say --
   * would be handed a pass that had already looked.
   */
  private async _run(): Promise<void> {
    try {
      let batch = this._take();
      while (batch.length > 0) {
        for (const pending of batch) {
          await this._apply(pending);
        }
        // Anything that changed while the batch was being written is a newer
        // state of a record we have just stored, so it goes round again rather
        // than waiting for the next event to carry it. Nothing can slip in
        // between the last empty take and the line below: from the moment the
        // final write resumes, this method runs to its end without suspending.
        batch = this._take();
      }
    } finally {
      this._writing = false;
    }
  }

  private _take(): readonly PendingChange[] {
    const batch = [...this._pending.values()];
    this._pending.clear();
    return batch;
  }

  private async _apply(pending: PendingChange): Promise<void> {
    if (pending.kind === 'store') {
      await this._store(pending.entry);
      return;
    }
    await this._discard(pending.terminalId);
  }

  private async _store(entry: TerminalEntry): Promise<void> {
    try {
      await this._options.repository.write(entry);
    } catch (cause: unknown) {
      this._options.logger.error(
        'a terminal could not be written to the store, so it is known only to this window',
        { terminalId: entry.terminalId.value, reason: String(cause) }
      );
    }
  }

  /**
   * The failure here is worth its own sentence, because its consequence is the
   * opposite of the one above: a record that could not be written is missing
   * from other windows, while a record that could not be discarded is still
   * THERE -- gone from this list, and back in every list on the machine as soon
   * as this window closes and stops holding it out of the projection.
   */
  private async _discard(terminalId: TerminalId): Promise<void> {
    try {
      await this._options.repository.remove(terminalId);
    } catch (cause: unknown) {
      this._options.logger.error(
        'a terminal record could not be discarded and is still in the store',
        { terminalId: terminalId.value, reason: String(cause) }
      );
    }
  }
}
