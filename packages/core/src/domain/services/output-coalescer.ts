import { ValidationError } from '../errors/gripterm-error';
import type { Disposable } from '../ports/disposable';
import type { Scheduler } from '../ports/scheduler';

/**
 * The chunks a pty produces, joined into the messages a page is sent.
 *
 * **A measurement rather than a tidiness** (M3.2 stage B, §6). The same 1.84
 * million characters reached the page as **163 messages** one `onData` chunk at
 * a time and as **10** through a 16 ms window: 24 to 29 times fewer, nothing
 * lost, and the round trip got FASTER rather than slower -- a receipt came back
 * in 17.5 ms on average against 48.1 unjoined, because each message costs a
 * structured clone and a task in the renderer.
 *
 * So the format of this channel is a joined string on a timer, and both halves
 * of that are the measured ones.
 *
 * **Trailing, never leading.** The window opens on the first chunk and the
 * delivery happens at its end, so a burst of thirty chunks is one message rather
 * than one message and then twenty-nine. What it costs is up to 16 ms of latency
 * on a single keystroke's echo, which is under what a person can see and two
 * orders below what the pty itself takes to answer.
 */
export const COALESCE_WINDOW_MS = 16;

export interface OutputCoalescerOptions {
  readonly scheduler: Scheduler;
  /** Called with everything collected, once per window. Never with an empty string. */
  readonly deliver: (text: string) => void;
  /** Defaults to `COALESCE_WINDOW_MS`. */
  readonly windowMs?: number;
}

export class OutputCoalescer implements Disposable {
  private readonly _scheduler: Scheduler;
  private readonly _deliver: (text: string) => void;
  private readonly _windowMs: number;
  /**
   * The chunks as they arrived, rather than one growing string: at the measured
   * rates -- millions of characters a second in pieces of a few thousand -- a
   * concatenation per arrival is the whole pending buffer copied per arrival.
   */
  private _pending: string[] = [];
  private _pendingChars = 0;
  private _window: Disposable | null = null;
  private _over = false;

  constructor(options: OutputCoalescerOptions) {
    const windowMs = options.windowMs ?? COALESCE_WINDOW_MS;
    if (!Number.isInteger(windowMs) || windowMs < 0) {
      throw new ValidationError('a coalescing window must be a whole, positive count of milliseconds', {
        details: { windowMs },
      });
    }
    this._scheduler = options.scheduler;
    this._deliver = options.deliver;
    this._windowMs = windowMs;
  }

  /** Code units collected and not yet delivered. */
  public get pendingChars(): number {
    return this._pendingChars;
  }

  public take(chunk: string): void {
    if (this._over) {
      // A chunk arriving after the end would arm a window nobody is left to
      // cancel, and its delivery would reach a consumer that has gone.
      return;
    }
    if (chunk.length === 0) {
      // A pty produces them. An empty chunk that armed a window would mean a
      // message carrying nothing at the end of it.
      return;
    }
    this._pending.push(chunk);
    this._pendingChars += chunk.length;
    this._window ??= this._scheduler.after(this._windowMs, () => {
      this._window = null;
      this._send();
    });
  }

  /**
   * Delivers what is held now, and closes the window it was waiting out.
   *
   * For the moments where waiting is wrong rather than merely slow: a process
   * that has ended will not fill the window it started, and its last line would
   * otherwise sit here until the next terminal wrote something.
   */
  public flush(): void {
    this._window?.dispose();
    this._window = null;
    this._send();
  }

  /**
   * Lets the coalescer go, DROPPING whatever it holds.
   *
   * Deliberately not a flush: this is called when the consumer is gone, and
   * delivering to it would be delivering into nothing. A caller for whom the
   * last bytes matter calls `flush()` first -- which is what the bridge does
   * when a terminal ends, in that order.
   */
  public dispose(): void {
    this._over = true;
    this._window?.dispose();
    this._window = null;
    this._pending = [];
    this._pendingChars = 0;
  }

  private _send(): void {
    if (this._pendingChars === 0) {
      return;
    }
    const text = this._pending.join('');
    this._pending = [];
    this._pendingChars = 0;
    this._deliver(text);
  }
}
