import { ValidationError } from '../errors/gripterm-error';

/**
 * When a terminal's output is held back, and -- the half that matters -- when it
 * is let go again.
 *
 * **The unit is UTF-16 code units**, what `String.prototype.length` counts, and
 * the same unit `ScreenBuffer` and VS Code's own pty host count in. Named rather
 * than left as "bytes" because this build promises emoji and CJK, where the two
 * answers differ.
 *
 * **Why there is a class here at all.** Back-pressure is one `if` and one
 * counter, and it is also the only act in M3.7 that no undo of ours reaches: a
 * `pause()` with no `resume()` after it leaves an agent blocked against a full
 * ConPTY buffer with nothing on any screen to say so (§I.3). Written inline in
 * the adapter it would be a rule nobody could exercise -- it needs a real pty, a
 * real webview and a real flood to reach. Written here it is a total function of
 * two counters, held at 100 % with the negative cases outnumbering the positive.
 *
 * **What it is not.** Not a queue: nothing is stored, nothing is replayed. It
 * counts what has been handed to a consumer and not yet acknowledged, and it
 * answers `'pause'` or `'resume'` at the two moments that answer changes -- once
 * each, so a caller can turn it straight into a call on a pty without keeping a
 * flag of its own.
 */

/**
 * Above this many unacknowledged code units, the process is told to stop.
 *
 * Measured, not chosen by taste (M3.2 stage B, §6, 120x30, VS Code 1.133 and
 * Cursor 3.13): with no pause at all the consumer fell **560 928** characters
 * behind on a stream of 1.84 million, so the line has to sit two orders of
 * magnitude below that or it engages when it is already too late. It also has
 * to sit ABOVE what a healthy consumer legitimately has in flight during a
 * burst -- a receipt comes back in up to 30 ms and a burst produces ~1.5 million
 * characters a second, so ~45 000 are in the air at the worst honest moment --
 * or back-pressure would throttle exactly the case it exists to protect.
 *
 * 50 000 is the owner's decision of 2026-08-17 between those two walls. VS
 * Code's own pty host uses 100 000 (A34); ours is half of it, because our
 * measurement asked for tens of kilobytes rather than hundreds.
 */
export const PAUSE_ABOVE_CHARS = 50_000;

/**
 * At or below this many unacknowledged code units, the process is let go again.
 *
 * Named for the comparison -- `<=`, not `<` -- because the difference is a
 * permanent pause: with receipts arriving per message, a consumer whose last one
 * lands exactly on the number would never cross a strict line, and the agent
 * would stay stopped on a screen that looks fine.
 *
 * Ten times below the pause line, so that a stream which just crossed it is not
 * released on the next receipt and does not flap.
 */
export const RESUME_NOT_ABOVE_CHARS = 5_000;

/** What just changed, or `null` when nothing did. The caller acts on it once. */
export type FlowMove = 'pause' | 'resume' | null;

export interface OutputFlowOptions {
  readonly pauseAboveChars?: number;
  readonly resumeNotAboveChars?: number;
}

export class OutputFlow {
  private readonly _pauseAbove: number;
  private readonly _resumeNotAbove: number;
  private _unacknowledged = 0;
  private _paused = false;

  constructor(options: OutputFlowOptions = {}) {
    const pauseAbove = options.pauseAboveChars ?? PAUSE_ABOVE_CHARS;
    const resumeNotAbove = options.resumeNotAboveChars ?? RESUME_NOT_ABOVE_CHARS;
    countOf(pauseAbove, 'the line output is paused above');
    countOf(resumeNotAbove, 'the line output is resumed at');
    if (resumeNotAbove >= pauseAbove) {
      // One line for both would flip a pty between stopped and running on every
      // receipt: no throughput gained, a great many native calls spent.
      throw new ValidationError('a flow must resume below the line it pauses at', {
        details: { pauseAbove, resumeNotAbove },
      });
    }
    this._pauseAbove = pauseAbove;
    this._resumeNotAbove = resumeNotAbove;
  }

  /** Code units handed to the consumer that it has not acknowledged. */
  public get unacknowledged(): number {
    return this._unacknowledged;
  }

  public get paused(): boolean {
    return this._paused;
  }

  /** Counts output handed to the consumer, and says whether that stops the process. */
  public sent(chars: number): FlowMove {
    countOf(chars, 'the output being sent');
    this._unacknowledged += chars;
    if (this._paused) {
      return null;
    }
    if (this._unacknowledged > this._pauseAbove) {
      this._paused = true;
      return 'pause';
    }
    return null;
  }

  /**
   * Counts a receipt, and says whether that lets the process go.
   *
   * Never below zero. A receipt for output sent before the consumer left can
   * arrive after it -- the channel keeps messages -- and a counter in credit
   * would owe a whole extra window of output before the next pause, which is the
   * same defect as no pause at all, arriving later.
   */
  public acknowledged(chars: number): FlowMove {
    countOf(chars, 'the output being acknowledged');
    this._unacknowledged = Math.max(0, this._unacknowledged - chars);
    if (!this._paused) {
      return null;
    }
    if (this._unacknowledged <= this._resumeNotAbove) {
      this._paused = false;
      return 'resume';
    }
    return null;
  }

  /**
   * The consumer is not there, or is not looking: the process is let go
   * unconditionally and its debt is forgotten.
   *
   * The rule the whole class exists for. A webview kept alive while hidden
   * (`retainContextWhenHidden`, M3.6) is a consumer that is formally alive and
   * silent: Chromium clamps a hidden frame's timers to about a second and xterm
   * schedules its writes through `setTimeout`, so receipts simply stop arriving.
   * A rule that only lifted a pause on receipts would hold it forever, and the
   * agent behind it would sit against a full buffer until somebody pressed
   * Ctrl+J. So invisibility, destruction and detachment are one thing here, and
   * that thing releases the process.
   */
  public left(): FlowMove {
    this._unacknowledged = 0;
    if (!this._paused) {
      return null;
    }
    this._paused = false;
    return 'resume';
  }
}

/**
 * A count of code units that is really one.
 *
 * A fraction, an infinity or a `NaN` reaching the counter would poison it for
 * the life of the terminal: every comparison against `NaN` is false, so the
 * process would either never be paused or never be released. Refused at the
 * door, where the caller that produced it is still on the stack.
 */
function countOf(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${what} must be a whole, positive count of code units`, {
      details: { value },
    });
  }
}
