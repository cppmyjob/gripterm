import type { ScreenReplay, TerminalExit, TerminalId } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * One terminal of an acceptance run, watched by the two things the suites used
 * to be blind to: whether its PROCESS is still there, and what it has printed.
 *
 * **The defect this exists for, measured 2026-09-08 (Ш38).** The acceptance ran
 * against the real `claude` 2.1.260 for the first time and went red on both
 * engines. Under `own` the suite said `gave up waiting for the session to start
 * after 90000 ms`. The window's own log of that run says something else: a
 * terminal was started at 14:40:59, and at 14:41:16 it closed with
 * `{"exitCode":1,"reason":"process","event":"LaunchExitedNonZero"}`. The process
 * died on the 17th second; the suite waited another 73 seconds and then named
 * the deadline as the cause. It was not the cause. An instrument that reports
 * the wrong reason is worse than a slow one.
 *
 * **What it waits on, and why it is NOT the record's state.** The refusal is
 * keyed on `TerminalHandle.onDidClose` -- the gateway's own witness that the
 * process behind this terminal exited, carrying the code and the reason. The
 * obvious-looking alternative, `isWitnessedEnd(entry.observed.state)`, is WRONG
 * here and was refuted before it was written: the record's `ended` says the
 * CONVERSATION is over, never that the process is. `/clear` walks a live
 * terminal straight through it -- `TerminalStateMachine` sends
 * `ConversationEnded` to `ended` and then `ConversationStarted` back out of it
 * ("the resurrection edge", in that file's own words), and the double delivers
 * the second of that pair by spawning a `node` rather than over HTTP, so the
 * record sits in `ended` for longer than one poll of this class. A refusal on
 * the record would have turned `p3-clear.test.ts` red on a terminal that was
 * never in any trouble. A refusal on the process cannot: nothing brings a pty
 * back, and no suite here expects one to.
 *
 * **What the screen is, and what it is not.** `TerminalStage` builds a bridge
 * for every terminal of ours the moment it opens -- "whether or not anybody is
 * looking" -- and the bridge keeps the tail of everything the process has
 * printed in a `ScreenBuffer`. That tail is what this prints, and it is:
 *
 *   * NOT a frame. It is the byte stream, escape sequences and all, so a program
 *     that repaints its screen in place appears here as every repaint one after
 *     another. Nothing in this repository renders it, and the rendering below --
 *     escape sequences dropped, carriage returns broken into lines -- is a
 *     readable approximation and not what a terminal would have drawn. It is
 *     enough for the question this was built for: IS THERE TEXT ABOUT TRUSTING
 *     THIS FOLDER IN WHAT THE CLI PRINTED. It is not enough for "what did the
 *     screen look like", and the day that second question is worth an emulator
 *     over this tail, it will be asked for with a reason.
 *   * NOT the whole scrollback. `SCREEN_BUFFER_CEILING_CHARS` is 200 000 UTF-16
 *     code units, about 55 screens at 120x30, and `droppedChars` says how much
 *     fell off the front. That number is printed beside the text: a replay which
 *     begins mid-stream looks exactly like a complete one.
 *   * absent under the `editor` engine, where no handle has a screen at all
 *     (§4.1) and the stage therefore holds no bridge. That is said in one line
 *     rather than printed as emptiness.
 *
 * **What its subscription costs.** One listener on the handle, taken once, never
 * removed by this class. It holds a field and nothing else -- no timer, no
 * interval, no process -- so a close arriving after every wait has finished sets
 * that field for nobody. Both gateways drop their close listeners once they have
 * fired, and an acceptance host runs one suite and exits, so there is nothing
 * here to leak into a second one.
 *
 * **One poll interval for all four suites**, 200 ms, which is what three of them
 * used. `rename-to-cli.test.ts` polled at 250 ms; the difference was never a
 * decision and is not preserved as one.
 */

/** The deadline every wait keeps while the process is alive and nothing arrives. */
export const SETTLES_WITHIN_MS = 90_000;

/** How often the question is asked again. */
const POLL_MS = 200;

/** How much of the tail is put on the run's output as text. */
const SCREEN_LINES = 40;

/** And how much of it goes there exactly as it arrived, in case the rendering below lies. */
const RAW_TAIL_CHARS = 300;

/**
 * What a bounded wait did when it was not allowed to throw.
 *
 * Only the trust-prompt window uses it: 15 s without a session is not a failure
 * there, it is the condition for sending the blind Enter.
 */
export type Waited = 'reached' | 'elapsed';

/** What one round of polling found. `died` is the process, never the conversation. */
type Polled<T> =
  | { readonly kind: 'there', readonly value: T }
  | { readonly kind: 'died' }
  | { readonly kind: 'elapsed' };

/**
 * An escape sequence, approximately.
 *
 * CSI, OSC and the short two-character escapes, which is what a CLI drawing a
 * prompt emits. An approximation on purpose: this is a rendering for a person
 * reading a run's output, not a parser, and a sequence it misses arrives in the
 * text as visible rubbish rather than as a wrong answer.
 */
// eslint-disable-next-line no-control-regex -- the subject of this expression IS the control characters a terminal eats: an escape sequence cannot be matched without naming ESC and BEL
const AN_ESCAPE = /\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][\dA-Za-z]|\x1b[=>78MDEHc]/gu;

/** Everything else a terminal eats rather than shows, tab and newline excepted. */
// eslint-disable-next-line no-control-regex -- as above: these ARE the characters being made visible, and a class that could not name them would leave them in the output raw
const A_CONTROL = /[\x00-\x08\v\f\x0e-\x1f\x7f]/gu;

/**
 * The tail as text a person can read in a run's output.
 *
 * Carriage returns become newlines rather than being dropped, which is the
 * honest shape of what is held: a line rewritten in place is several lines here,
 * and the alternative -- keeping the last of them -- would be this function
 * deciding what the terminal drew.
 */
function readable(text: string, lines: number): string {
  const shown = text
    .replace(AN_ESCAPE, '')
    .replace(/\r\n?/gu, '\n')
    .replace(A_CONTROL, (one) => `\\x${(one.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
  return shown.length === 0 ? '(the tail holds no printable line)' : shown.join('\n');
}

/**
 * The terminal one acceptance suite is working on, and every wait that suite
 * makes.
 *
 * Made once, straight after `gripterm.newTerminal` has put a record in the
 * registry: the close listener has to be in place before the process has any
 * chance to end, which is the whole point of it.
 */
export class WatchedTerminal {
  private readonly _gripterm: GriptermApi;
  private readonly _id: string;
  /** What the gateway said when the process ended, or `null` while it is alive. */
  private _exit: TerminalExit | null = null;

  constructor(gripterm: GriptermApi, terminalId: TerminalId) {
    this._gripterm = gripterm;
    this._id = terminalId.value;
    const handle = gripterm.gateway.handleFor(terminalId);
    if (handle === undefined) {
      // Said rather than thrown: a suite that cannot hear the end still runs,
      // and it now runs knowing that its waits are back to being timed ones.
      console.log(`watching ${this._id}: the gateway is not holding this terminal, so nothing here can hear its process end`);
      return;
    }
    handle.onDidClose((exit) => {
      this._exit = exit;
    });
  }

  /**
   * Puts the terminal's own output on the run's output, labelled with the moment
   * it was taken.
   *
   * Read the head of this file before believing what it prints: it is the tail
   * of a byte stream, not a frame.
   */
  public showTheScreen(when: string): void {
    const bridge = this._gripterm.stage.bridgeFor(this._id);
    if (bridge === undefined) {
      console.log(`screen ${when}: there is none -- ${this._whyThereIsNoScreen()}`);
      return;
    }
    const replay: ScreenReplay = bridge.tail;
    console.log(
      `screen ${when}: ${replay.text.length} code units held, ${replay.droppedChars} dropped off the front before them`
    );
    console.log(`screen ${when}, its last ${SCREEN_LINES} printable lines with the escape sequences taken out:`);
    console.log(readable(replay.text, SCREEN_LINES));
    console.log(
      `screen ${when}, its last ${RAW_TAIL_CHARS} code units exactly as they arrived: `
      + JSON.stringify(replay.text.slice(-RAW_TAIL_CHARS))
    );
  }

  /**
   * Waits for something to become true, and refuses when it cannot become true
   * any more.
   *
   * Two ways out besides success, and they are different sentences: the process
   * ended, or the deadline passed with the process still alive.
   */
  public async until(
    what: string,
    ready: () => boolean | Promise<boolean>,
    ms: number = SETTLES_WITHIN_MS
  ): Promise<void> {
    await this.untilThere<true>(what, async () => (await ready() ? true : null), ms);
  }

  /** The same wait, for a value: the first thing the look finds that is not `null`. */
  public async untilThere<T>(
    what: string,
    look: () => T | null | Promise<T | null>,
    ms: number = SETTLES_WITHIN_MS
  ): Promise<T> {
    const polled = await this._poll(look, ms);
    if (polled.kind === 'there') {
      return polled.value;
    }
    if (polled.kind === 'died') {
      this._giveUp(what, this._itDied(what, ms));
    }
    this._giveUp(what, `gave up waiting for ${what} after ${ms} ms`);
  }

  /**
   * A bounded wait that is allowed to come back empty-handed.
   *
   * The end of the process is still a refusal here: an Enter typed at a pty that
   * has exited reaches nothing -- `write` after the end is ignored by the port's
   * own measured rule, and the gateway has forgotten the handle by then anyway --
   * so there is nothing left for the caller to try.
   */
  public async waitedFor(
    what: string,
    ready: () => boolean | Promise<boolean>,
    ms: number
  ): Promise<Waited> {
    const polled = await this._poll<true>(async () => (await ready() ? true : null), ms);
    if (polled.kind === 'died') {
      this._giveUp(what, this._itDied(what, ms));
    }
    return polled.kind === 'there' ? 'reached' : 'elapsed';
  }

  /**
   * One question, asked until it is answered or until it stops being worth
   * asking.
   *
   * The order of the three checks is the substance. What was asked for is looked
   * at FIRST, so that a value which arrived in the same breath as the exit still
   * counts -- a process ending is not evidence that nothing happened before it.
   * The exit comes second, and the clock last, because the clock is the answer
   * this class exists to stop giving.
   */
  private async _poll<T>(look: () => T | null | Promise<T | null>, ms: number): Promise<Polled<T>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = await look();
      if (found !== null) {
        return { kind: 'there', value: found };
      }
      if (this._exit !== null) {
        return { kind: 'died' };
      }
      if (Date.now() > deadline) {
        return { kind: 'elapsed' };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /** The refusal, and the only one in this file: the screen first, then the sentence. */
  private _giveUp(what: string, why: string): never {
    this.showTheScreen(`when this run gave up waiting for ${what}`);
    throw new Error(why);
  }

  /** What the gateway said, in the words a person needs instead of a deadline. */
  private _itDied(what: string, ms: number): string {
    const code = this._exit?.code === undefined ? 'none was said' : String(this._exit.code);
    const reason = this._exit === null ? 'unknown' : this._exit.reason;
    return `the process behind this terminal ended while waiting for ${what}: exit code ${code}, reason ${reason}`
      + ` -- nothing was going to arrive, so the wait stops here rather than at its ${ms} ms deadline`;
  }

  /** Why the panel has no bridge for this terminal, which is two different facts. */
  private _whyThereIsNoScreen(): string {
    return this._gripterm.readiness.engine === 'editor'
      ? 'the editor`s engine hands out no screen beside a handle (§4.1), so the panel holds no bridge for this terminal and there is nothing to print'
      : 'this window`s panel holds no bridge for it, which under our own engine it should: the stage takes a terminal when the gateway calls `opened` with a handle that HAS a screen';
  }
}
