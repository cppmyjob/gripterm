/**
 * One queue for every entrance, in place of a boolean that says "busy".
 *
 * **The defect this replaces, and why a rename would not have done it.**
 * `VsCodeEditorStrip` had a field called `_arranging`, set while the object was
 * moving editor groups about, and three of its four entrances began with
 * `if (this._arranging) return;`. That is a lock that DROPS what it refuses.
 * The editor announces tab and group changes in bursts, and the burst that
 * arrives while a turn is running is precisely the burst that says the window
 * the turn is reading has moved -- so the one wake-up that mattered was the one
 * guaranteed to be thrown away. The fourth entrance, `column()`, took no guard
 * at all, so an event could run a rule inside its awaits and renumber the very
 * column it was about to answer with.
 *
 * A queue answers the same question -- "not now" -- and keeps it. Nothing here
 * is about concurrency in the abstract: it is about the two sentences
 *
 *     the boolean loses a wake-up
 *     the queue defers it
 *
 * being different sentences.
 *
 * **Two kinds of turn, because the callers are two kinds.** `ask` is somebody
 * waiting for an answer, and every one of them has to run and to answer its own
 * caller. `nudge` is an event saying the window moved; a dozen of those are one
 * piece of work, and they collapse -- but ONLY while they are waiting. A nudge
 * that arrives while a turn of the same name is RUNNING is the case the boolean
 * lost, and it is the one case that must queue another turn: whatever the
 * running turn has already read, it read before the change.
 *
 * **What it does not promise.** It is not a mutex over the editor: nothing stops
 * a command from somewhere else in this extension moving a group while a turn
 * of this queue is running. It orders the turns THIS object takes, which is
 * what the lost wake-up was about. It has no timeout either -- a turn that never
 * returns holds the queue for ever, and the ceiling for that belongs to the
 * turn, where the thing being waited for is known (`QuietSpell`).
 */
export interface TurnFailure {
  /** The name the turn was queued under, so a log line can say which one. */
  readonly what: string;
  readonly cause: unknown;
}

export interface OneTurnAtATimeOptions {
  /**
   * Where a NUDGED turn's failure goes.
   *
   * Asked turns answer their own caller and are not reported here: a failure
   * said twice reads as two failures. A nudged turn has no caller at all -- the
   * editor moved something, and nobody is waiting -- so without this its throw
   * would be an unhandled rejection in an extension host, which is a line in
   * somebody else's log and in none of ours.
   */
  readonly onFailed: (failure: TurnFailure) => void;
}

export class OneTurnAtATime {
  private readonly _onFailed: (failure: TurnFailure) => void;
  /**
   * The end of the queue: every turn is chained onto it, and it never rejects.
   *
   * A promise chain rather than an array of pending work, because the ordering
   * this needs is exactly the ordering `then` already gives, and a second
   * implementation of it here would be a second place for it to be wrong.
   */
  private _tail: Promise<void> = Promise.resolve();
  private _running: string | null = null;
  private readonly _waiting: string[] = [];

  constructor(options: OneTurnAtATimeOptions) {
    this._onFailed = options.onFailed;
  }

  /** The turn that is running, by name, or `null` when nothing is. For the log. */
  public get running(): string | null {
    return this._running;
  }

  /** The turns queued behind it, in order and by name. For the log. */
  public get waiting(): readonly string[] {
    return [...this._waiting];
  }

  /**
   * A turn that must run, and whose answer belongs to whoever asked for it.
   *
   * Every call queues one: two people asking for a column are two questions,
   * and collapsing them would answer one of them with the other's answer.
   */
  public async ask<T>(what: string, work: () => Promise<T>): Promise<T> {
    this._waiting.push(what);
    const mine = this._tail.then(async () => {
      this._take(what);
      try {
        return await work();
      } finally {
        this._running = null;
      }
    });
    // The chain must never carry a rejection: the turn behind a failed one is
    // not part of the failure. The caller still gets `mine`, rejection and all.
    this._tail = mine.then(
      () => undefined,
      () => undefined
    );
    // Everything above runs before the first `await`, which is why this can be
    // an `async` method at all: the turn is in the queue by the time the caller
    // gets its promise back, and two calls in one tick keep their order.
    return await mine;
  }

  /**
   * A turn nobody is waiting for, of which at most one is ever QUEUED under one
   * name.
   *
   * The collapsing stops the moment the turn starts running, which is the whole
   * of the difference from the boolean this replaces -- see the note at the top
   * of the file.
   */
  public nudge(what: string, work: () => Promise<void>): void {
    if (this._waiting.includes(what)) {
      return;
    }
    this._waiting.push(what);
    this._tail = this._tail.then(async () => {
      this._take(what);
      try {
        await work();
      } catch (cause: unknown) {
        this._onFailed({ what, cause });
      } finally {
        this._running = null;
      }
    });
  }

  /**
   * Answers when everything queued as of NOW has run.
   *
   * Not a promise that the queue is idle afterwards -- a turn queued while this
   * is waiting is not in it. It exists so that a test can say "and then let it
   * finish" without a sleep, and so that a window on its way down can let a
   * turn end rather than be torn out from under it.
   */
  public async whenEmpty(): Promise<void> {
    await this._tail;
  }

  private _take(what: string): void {
    const at = this._waiting.indexOf(what);
    if (at >= 0) {
      this._waiting.splice(at, 1);
    }
    this._running = what;
  }
}
