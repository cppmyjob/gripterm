import type { Clock } from '../ports/clock';

/**
 * A start, broken into the parts it was made of.
 *
 * `tookMs` is the whole -- the SAME number the two lines of a start already
 * print, computed from the same instant of waking and the same clock. Nothing
 * here is a second stopwatch: the ledger is where that one number is taken
 * from, and the parts are a division of it.
 *
 * The three fields obey one equality, always and by construction:
 *
 *     sum(phases) + remainderMs === tookMs
 *
 * A breakdown that does not add up lies the more convincingly the more detailed
 * it looks, so nothing here is allowed to round, to overlap or to be dropped.
 */
export interface StartBreakdown {
  /** From waking up to now. */
  readonly tookMs: number;
  /**
   * Milliseconds by part, in the order the parts first opened.
   *
   * Every number in here is a slice of `tookMs` that no other number in here
   * contains -- see `measure` for what that means when one part runs inside
   * another. A part that never ran is ABSENT; a part that ran and cost nothing
   * is `0`, which is a measurement rather than a gap.
   */
  readonly phases: Readonly<Record<string, number>>;
  /**
   * What is left of the whole once every part is taken out of it, NAMED rather
   * than shared out.
   *
   * It is everything nobody put a name on: constructing objects, reading
   * settings, registering commands, the editor's own time between our calls. A
   * large leftover is a fact about the breakdown -- that it does not yet reach
   * where the time goes -- and hiding it inside the parts would turn that fact
   * into a wrong answer.
   */
  readonly remainderMs: number;
}

export interface StartLedgerOptions {
  readonly clock: Clock;
  /** The instant the window woke, as the caller already stamped it. */
  readonly wokeAtMs: number;
}

/** A part that has been opened and not yet closed, and when it last began accumulating. */
interface OpenPhase {
  readonly phase: string;
  sinceMs: number;
}

/**
 * What a start spent, part by part (Ш22).
 *
 * **Why it exists.** The customer's complaint is about time -- "it loads for up
 * to a minute" -- and until this, a start said only how long the whole of it
 * took. Ш11 removed four named causes and closed less than a second of the
 * 8 293 ms measured in the owner's own window on 2026-08-23; the remaining
 * seven seconds are explained by nothing. They cannot be measured from here
 * either: the store they happen over is the owner's, and we do not read it. So
 * the instrument is HANDED TO THEM instead of applied to them -- a start writes
 * down what it was made of, into this build's own log, and the numbers of that
 * machine are read on that machine.
 *
 * **It is not a third counter.** `wokeAtMs` is the one the composition root
 * already stamps, `clock` is the one it already holds, and `tookMs` here is the
 * expression those two lines already print. What is new is the division, not
 * the measurement.
 *
 * **Parts may nest, and a part is credited only with its own time.** The survey
 * of the machine reads the records, asks which windows are alive, lists the
 * conversations and asks the CLI what it is running -- the last two through
 * callbacks the caller owns, so they can be named while the survey around them
 * is named too. Were both credited in full, the two would overlap and the sum
 * would exceed the whole. Instead the innermost open part is the one
 * accumulating, so `readingTheMachine` reports the survey MINUS the parts named
 * inside it, and every number printed stays a slice nothing else contains.
 *
 * **What it cannot see.** Anything outside the function it is threaded through.
 * The first paint of the list is the standing example: the editor asks the tree
 * for its rows after activation has returned, so no part here covers it, and
 * this ledger reports no number for it rather than a nought.
 *
 * **The one shape it gets wrong, named rather than defended against.** It keeps
 * a stack, so it assumes the parts are strictly nested: opened last, closed
 * first. Two parts running AT ONCE -- a timed callback fired by an event while a
 * timed await is in flight -- would trade labels between them. The equality
 * above survives it (every interval between two of its own events is still
 * credited to exactly one part), which is why the failure is a wrong NAME and
 * never a wrong total. A start is threaded so that this does not arise: every
 * part is a call the composition root awaits in order, and the two that are
 * callbacks are called from inside the part that contains them.
 */
export class StartLedger {
  private readonly _clock: Clock;
  private readonly _wokeAtMs: number;
  /** Milliseconds credited so far, keyed by part, in the order the parts first opened. */
  private readonly _spent = new Map<string, number>();
  /** The parts currently open, innermost last. Only the last one is accumulating. */
  private readonly _open: OpenPhase[] = [];

  constructor(options: StartLedgerOptions) {
    this._clock = options.clock;
    this._wokeAtMs = options.wokeAtMs;
  }

  /**
   * Times an await under `phase`, and hands back whatever it answered.
   *
   * A failure is let through unchanged and the part still keeps what it spent:
   * work that threw took time, and a breakdown that dropped it would not add up.
   */
  public async measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
    this._enter(phase);
    try {
      return await work();
    } finally {
      this._leave();
    }
  }

  /** The same for work that does not wait. */
  public time<T>(phase: string, work: () => T): T {
    this._enter(phase);
    try {
      return work();
    } finally {
      this._leave();
    }
  }

  /**
   * The whole and its parts, as of this instant.
   *
   * A part still running is credited up to now rather than left out, so that
   * work in flight cannot hide inside the leftover.
   */
  public breakdown(): StartBreakdown {
    const nowMs = this._clock.now().getTime();
    const phases: Record<string, number> = {};
    for (const [phase, ms] of this._spent) {
      phases[phase] = ms;
    }
    const innermost = this._open.at(-1);
    if (innermost !== undefined) {
      phases[innermost.phase] = (phases[innermost.phase] ?? 0) + (nowMs - innermost.sinceMs);
    }
    const tookMs = nowMs - this._wokeAtMs;
    let counted = 0;
    for (const ms of Object.values(phases)) {
      counted += ms;
    }
    return { tookMs, phases, remainderMs: tookMs - counted };
  }

  private _enter(phase: string): void {
    const nowMs = this._clock.now().getTime();
    const innermost = this._open.at(-1);
    if (innermost !== undefined) {
      // Whatever the part around this one has spent so far belongs to it, and
      // what happens from here belongs to the one being opened.
      this._credit(innermost.phase, nowMs - innermost.sinceMs);
      innermost.sinceMs = nowMs;
    }
    if (!this._spent.has(phase)) {
      // Present at nought from the moment it opens, so that a part which ran and
      // cost nothing reads differently from one that never ran at all.
      this._spent.set(phase, 0);
    }
    this._open.push({ phase, sinceMs: nowMs });
  }

  private _leave(): void {
    const nowMs = this._clock.now().getTime();
    const closed = this._open.pop();
    if (closed === undefined) {
      return;
    }
    this._credit(closed.phase, nowMs - closed.sinceMs);
    const around = this._open.at(-1);
    if (around !== undefined) {
      around.sinceMs = nowMs;
    }
  }

  private _credit(phase: string, ms: number): void {
    this._spent.set(phase, (this._spent.get(phase) ?? 0) + ms);
  }
}
