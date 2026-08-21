import { OutputCoalescer, OutputFlow, ScreenBuffer } from '@gripterm/core';
import type {
  Disposable,
  FlowMove,
  Logger,
  Scheduler,
  ScreenReplay,
  TerminalScreen,
} from '@gripterm/core';
import type { HostMessage } from '@gripterm/webview';

/**
 * One terminal's bytes, between a pty and a page.
 *
 * Everything it does is somebody else's rule applied to one process: the tail is
 * a `ScreenBuffer`, the joining is an `OutputCoalescer`, the pausing is an
 * `OutputFlow`. What is left here -- and the only thing that could not be
 * decided in the core -- is WHICH of them each byte goes to, and that depends on
 * one question: is anybody looking at this terminal right now.
 *
 *   * **Somebody is looking.** Output goes to the tail and into the 16 ms
 *     window; each message is counted against the flow; a page that falls behind
 *     stops the pty, and its receipts start it again.
 *   * **Nobody is looking** -- the panel is hidden, or another terminal has the
 *     screen. The flow is released UNCONDITIONALLY (a hidden webview keeps its
 *     page but Chromium clamps its timers, so receipts stop arriving and a
 *     pause would never lift), and output goes to the tail and to a second
 *     buffer of what the screen has not been shown.
 *
 * When somebody looks again, that second buffer decides which of two things
 * happens, and the difference is the owner's decision of 2026-08-17: if nothing
 * was lost from it, it is sent as ordinary output and the person's scrollback,
 * selection and cursor survive -- which is what `retainContextWhenHidden` was
 * paid for in M3.6. If it overflowed, the screen is redrawn from the tail and
 * says how much is missing, because a replay that starts mid-stream looks
 * exactly like a complete one.
 */

export interface TerminalBridgeOptions {
  readonly terminalId: string;
  readonly screen: TerminalScreen;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Called once, when the process behind this terminal has ended. */
  readonly ended: (because: string) => void;
}

/** Where a message goes when there is a page to take it. */
export type Sink = (message: HostMessage) => void;

/**
 * How long a size is held before the pty is told, so that a burst is one size.
 *
 * Measured rather than chosen, and measured twice. The page answers with its
 * size once when a terminal is attached and again when the panel has finished
 * laying out -- the page's own settle is 80 ms (`SETTLE_MS` in the webview) --
 * and the two answers are different sizes while the panel is still moving. Seen
 * from here they were 110 ms apart in one run and 159 ms in another, so a
 * window of 150 ms was not enough: the pair went through and ConPTY
 * acknowledged neither of them, leaving the pty at the 80x30 it was spawned
 * with while the screen was 46x12.
 *
 * A quarter of a second is above both measurements and is the same quarter the
 * gateway already spends after a pty's first output, for the same reason and
 * against the same platform. It is spent where nobody is looking: xterm has
 * already reflowed for the person, and what waits is only the number the agent
 * behind the pty is told to draw at. A person dragging the panel's border still
 * gets four sizes a second.
 *
 * The condition for taking this out: a ConPTY that answers a resize sent on top
 * of another.
 */
const SIZES_SETTLE_MS = 250;

export class TerminalBridge implements Disposable {
  private readonly _options: TerminalBridgeOptions;
  /** What this terminal has printed, under a ceiling: what a rebuilt page is drawn from. */
  private readonly _tail = new ScreenBuffer();
  /**
   * What no screen has been shown yet.
   *
   * Its own buffer rather than a position in the tail, because a position is not
   * a thing a ring buffer can keep: the tail trims from the front, so an index
   * into it means something different a moment later. Its ceiling is the tail's,
   * which makes the overflow question exact -- once it has dropped anything, the
   * tail is the best replay there is anyway.
   */
  private readonly _unsent = new ScreenBuffer();
  private readonly _flow = new OutputFlow();
  private readonly _coalescer: OutputCoalescer;
  private readonly _subscriptions: Disposable[] = [];
  private _sink: Sink | null = null;
  private _sentChars = 0;
  private _attachCount = 0;
  private _resizeCount = 0;
  private _lastSize: { readonly cols: number, readonly rows: number } | null = null;
  /** The last size of a burst still being waited out, or `null` for none. */
  private _wantedSize: { readonly cols: number, readonly rows: number } | null = null;
  private _sizeSoon: Disposable | null = null;
  private _over = false;

  constructor(options: TerminalBridgeOptions) {
    this._options = options;
    this._coalescer = new OutputCoalescer({
      scheduler: options.scheduler,
      deliver: (text) => { this._deliver(text); },
    });
    this._subscriptions.push(
      options.screen.onData((chunk) => { this._arrived(chunk); }),
      options.screen.onExit((exit) => { this._ended(exit.code, exit.signal); })
    );
  }

  public get terminalId(): string {
    return this._options.terminalId;
  }

  /** Whether a page is being sent this terminal's output right now. */
  public get attached(): boolean {
    return this._sink !== null;
  }

  /** Code units posted to a page since this terminal started. */
  public get sentChars(): number {
    return this._sentChars;
  }

  /**
   * How many times a screen has been drawn from this terminal's tail.
   *
   * The number the promise of M3.9 is made of: switching tabs must not redraw
   * anything, and "it was not redrawn" is otherwise unfalsifiable -- a redraw
   * from the tail looks exactly like the screen that was already there. One
   * attach per terminal per page is the whole of what a switch may cost.
   */
  public get attachCount(): number {
    return this._attachCount;
  }

  /**
   * How many sizes this bridge has passed on to the pty.
   *
   * The number the rule below is made of: the same size twice is one resize, and
   * "it was sent once" is otherwise unfalsifiable -- the pseudoconsole answers
   * only the first resize a pty ever gets, so nothing further down can tell one
   * call from two.
   */
  public get resizeCount(): number {
    return this._resizeCount;
  }

  /** Code units posted and not yet acknowledged. */
  public get unacknowledged(): number {
    return this._flow.unacknowledged;
  }

  /** Whether the process is being held back right now. */
  public get paused(): boolean {
    return this._flow.paused;
  }

  /**
   * Whether the process behind this terminal has gone.
   *
   * The bridge outlives it, and that is deliberate since M3.9: the tab of a
   * terminal that ended stays until the person closes it (the owner's decision
   * of 2026-08-18), and the tail kept here is what a page rebuilt afterwards
   * draws that screen from. What ends with the process is what may be SENT to
   * it -- see `type` and `resize`.
   */
  public get over(): boolean {
    return this._over;
  }

  /**
   * The last size this terminal was told to take, or `null` if it never was.
   *
   * Kept because it is the last point on this side of the boundary where a
   * resize can be OBSERVED. What the pseudoconsole then does with it is the
   * platform's business, and the platform is not consistent about saying so:
   * ConPTY announces the first resize in the output stream (`ESC[8;h;w t`) and
   * says nothing about the later ones (measured 2026-08-17). A suite that had
   * only the stream to read could therefore check the first resize and no other.
   */
  public get lastSize(): { readonly cols: number, readonly rows: number } | null {
    return this._lastSize;
  }

  /** Code units that arrived while no screen was showing this terminal. */
  public get unsentChars(): number {
    return this._unsent.length;
  }

  /**
   * What this terminal has printed, under the ceiling, as a copy.
   *
   * A copy each time -- the buffer holds chunks and this joins them -- so it is
   * for the moments that need the whole text: an attach, and a suite asking
   * whether what a process printed really reached this window. It is not logged
   * and never reaches disk (§7.2: there is no recording).
   */
  public get tail(): ScreenReplay {
    return this._tail.snapshot();
  }

  /**
   * Gives this terminal to a page that has nothing of it: a fresh screen, drawn
   * from the tail.
   *
   * Also the answer to `ready`, which is the same situation arriving from the
   * other direction -- a page that was thrown away and rebuilt knows neither
   * which agent it belongs to nor anything it printed.
   */
  public attach(sink: Sink): void {
    this._sink = sink;
    this._attachCount += 1;
    // Nothing that was in flight to the previous screen counts against this one.
    this._apply(this._flow.left());
    const replay = this._tail.snapshot();
    this._unsent.clear();
    sink({
      kind: 'attach',
      terminalId: this.terminalId,
      replay: replay.text,
      droppedChars: replay.droppedChars,
    });
  }

  /**
   * Gives this terminal back to the page that still holds it, after the panel
   * was hidden.
   *
   * Returns whether the screen was redrawn -- true when what arrived while the
   * panel was away did not fit in the buffer and the whole tail had to be sent
   * again, which is the case where the person loses their scroll position.
   */
  public resume(sink: Sink): boolean {
    const missed = this._unsent.snapshot();
    if (missed.droppedChars > 0) {
      this.attach(sink);
      return true;
    }
    this._sink = sink;
    this._apply(this._flow.left());
    this._unsent.clear();
    if (missed.text.length > 0) {
      this._post({ kind: 'output', terminalId: this.terminalId, data: missed.text });
    }
    return false;
  }

  /**
   * Nobody is looking any more: the panel was hidden, or another terminal took
   * the screen.
   *
   * The pending window is delivered FIRST, while there is still somewhere for it
   * to go: a page kept alive behind a hidden panel will parse it when it is next
   * scheduled, and what it has already been given must not also be waiting in
   * the unsent buffer.
   */
  public hide(): void {
    if (this._sink === null) {
      return;
    }
    this._coalescer.flush();
    this._sink = null;
    // The unconditional release. Everything else in this class is a preference;
    // this is the line that keeps an agent from sitting against a full buffer
    // for as long as the panel stays hidden.
    this._apply(this._flow.left());
  }

  /** A receipt from the page: this much of what was sent has been parsed. */
  public acknowledged(chars: number): void {
    this._apply(this._flow.acknowledged(chars));
  }

  /**
   * What the person typed, towards the process. Nothing is added to it.
   *
   * Refused once the process has gone, and that guard is the price of keeping
   * the bridge alive after it (M3.9): the screen of an ended terminal is still
   * on the stack and can still be typed into, and what is behind it is a pty
   * this window has already disposed of.
   */
  public type(data: string): void {
    if (this._over) {
      return;
    }
    this._options.screen.write(data);
  }

  /**
   * The size the screen settled at, towards the pty -- once per size.
   *
   * **The same size twice is dropped, and that is a measurement rather than
   * tidiness (2026-08-18).** A screen made for a terminal that has just been
   * attached answers with its size TWICE: once through xterm's own `onResize`,
   * once because the page says it unprompted (a terminal attaching to a screen
   * that is already the right size would otherwise never tell its pty anything
   * at all). Both answers are right. Sent both, they reach ConPTY within a
   * millisecond of each other and the pseudoconsole acknowledges NEITHER -- no
   * `ESC[8;rows;cols t` in the output stream, and the agent's first frame is
   * drawn at a width nobody has. Sent once, it acknowledges.
   *
   * **The same rule over TIME, and that half was missing until 2026-08-21.**
   * Dropping repeats by VALUE assumed the two answers are the same size. They
   * are not always: the panel is still laying out when the first one is taken.
   * Polling the page from the moment our view says it is visible gives
   * `+2ms 25x13` and then `+112ms 75x13` -- a third of the width it settles at,
   * with `visible` true for all of it. Two DIFFERENT sizes collapse into
   * nothing, both reach ConPTY together, and it acknowledges neither: a live run
   * caught exactly that, with the pty left at the 80x30 it was spawned with
   * while the screen was 46x12. So a size is now held for `SIZES_SETTLE_MS` and
   * the LAST one of a burst is what the pty is told.
   *
   * The delay is spent on the pty and never on the screen: xterm has already
   * reflowed for the person by then, and what waits is the number the agent is
   * told to draw at.
   *
   * What the PROGRAM behind the pty makes of a resize is a separate question and
   * an open one: measured on this machine, `process.stdout.columns` inside it
   * never moves from the size it was spawned with, whatever the pseudoconsole is
   * told -- on the build before M3.9 exactly as on this one (A48, for a live
   * agent and the owner's eyes in M3.14).
   */
  public resize(cols: number, rows: number): void {
    if (this._over) {
      return;
    }
    if (this._lastSize?.cols === cols && this._lastSize.rows === rows) {
      // Back where the pty already is. A burst that ends here has nothing to
      // say, and saying it would be the very pair this method exists to avoid.
      this._wantedSize = null;
      return;
    }
    this._wantedSize = { cols, rows };
    if (this._sizeSoon !== null) {
      return;
    }
    this._sizeSoon = this._options.scheduler.after(SIZES_SETTLE_MS, () => {
      this._sizeSoon = null;
      this._sendWantedSize();
    });
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
    this._coalescer.dispose();
    this._sizeSoon?.dispose();
    this._sizeSoon = null;
    this._sink = null;
  }

  /** The last size of the burst that just ended, towards the pty. */
  private _sendWantedSize(): void {
    const wanted = this._wantedSize;
    this._wantedSize = null;
    if (wanted === null || this._over) {
      return;
    }
    if (this._lastSize?.cols === wanted.cols && this._lastSize.rows === wanted.rows) {
      return;
    }
    this._lastSize = wanted;
    this._resizeCount += 1;
    this._options.screen.resize(wanted.cols, wanted.rows);
  }

  private _arrived(chunk: string): void {
    this._tail.append(chunk);
    if (this._sink === null) {
      this._unsent.append(chunk);
      return;
    }
    this._coalescer.take(chunk);
  }

  private _deliver(text: string): void {
    if (this._sink === null) {
      // A window that closed between the last chunk and the end of its window.
      // Kept rather than dropped: it is output the screen has not been shown.
      this._unsent.append(text);
      return;
    }
    this._post({ kind: 'output', terminalId: this.terminalId, data: text });
  }

  private _post(message: HostMessage & { readonly kind: 'output' }): void {
    this._sink?.(message);
    this._sentChars += message.data.length;
    this._apply(this._flow.sent(message.data.length));
  }

  private _apply(move: FlowMove): void {
    if (move === null) {
      return;
    }
    if (move === 'pause') {
      this._options.screen.pause();
      // At `info` and with the number: an agent that stopped printing is the
      // symptom a person reports, and this is the line that answers it.
      this._options.logger.info('a terminal was held back because its screen is falling behind', {
        terminalId: this.terminalId,
        unacknowledged: this._flow.unacknowledged,
      });
      return;
    }
    this._options.screen.resume();
    this._options.logger.info('a terminal was let go again', {
      terminalId: this.terminalId,
      unacknowledged: this._flow.unacknowledged,
    });
  }

  private _ended(code: number | undefined, signal: number | undefined): void {
    if (this._over) {
      return;
    }
    this._over = true;
    // Before anything else: the last thing an agent prints is why it is going,
    // and a window that will never be filled would hold it forever.
    this._coalescer.flush();
    this._options.ended(endedBecause(code, signal));
  }
}

/** What the screen is told to show under the output of a terminal that has ended. */
function endedBecause(code: number | undefined, signal: number | undefined): string {
  if (signal !== undefined) {
    return `the process was ended by signal ${String(signal)}`;
  }
  if (code === undefined) {
    return 'the process ended';
  }
  if (code === 0) {
    return 'the process ended';
  }
  return `the process ended with code ${String(code)}`;
}
