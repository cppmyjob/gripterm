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
 *     enough for the two questions this was built for: IS THERE TEXT ABOUT
 *     TRUSTING THIS FOLDER IN WHAT THE CLI PRINTED, and WHICH OF THE TWO ANSWERS
 *     IS THE CURSOR ON. Both are asked of the LAST repaint in the tail, which is
 *     the only one that is still on the screen. It is not enough for "what did
 *     the screen look like", and the day that second question is worth an
 *     emulator over this tail, it will be asked for with a reason.
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
 *
 * **THE SECOND DEFECT, ANSWERED HERE ON 2026-09-08 (Ш39).** The frame Ш38 taught
 * this class to print was printed, and this is what was on it:
 *
 * ```
 * Accessing workspace: c:\...\gripterm-acceptance\project
 * Quick safety check: Is this a project you created or one you trust?
 * (Like your own code, a well-known open source project, or work from your team).
 * If not, take a moment to review what's in this folder first.
 * Claude Code'll be able to read, edit, and execute files here.
 * Security guide
 *  ❯ No, exit
 *    Yes, I trust this folder
 *  Enter to confirm · Esc to cancel
 * ```
 *
 * The cursor is on `No, exit`, and the Enter each of the four suites sent on the
 * 15th second was landing on it: the acceptance was choosing "no, leave" and
 * `claude` was leaving with code 1 on the 17th second, three runs out of three.
 * So the Enter is gone from all four suites, and `theSessionStarts` below is the
 * one place a key is sent from -- after the screen has been read, onto the choice
 * the screen says the cursor is on, and never otherwise. Under the `editor`
 * engine, where there is no screen to read at all, it refuses instead of
 * guessing: see that method.
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
 * Only `theSessionStarts` uses it: 15 s without a session is not a failure
 * there, it is the condition for reading the screen and answering what is on it.
 */
export type Waited = 'reached' | 'elapsed';

/**
 * How long a session is given before the screen is read.
 *
 * The number is Ш38's and it was chosen there as the window in which a trust
 * prompt would have arrived. What changed in Ш39 is what happens at the end of
 * it: a key used to go out blind, and now the screen is read first.
 */
const A_SESSION_STARTS_WITHIN_MS = 15_000;

/**
 * The three lines of the measured question, and the glyph that says which answer
 * the cursor is on.
 *
 * MEASURED 2026-09-08, CLI 2.1.260, quoted in full at the head of this file. The
 * double in `tests/acceptance/fake-claude/` prints the same words, so that this
 * path is walked by every acceptance run rather than only by one that costs
 * turns, and `tests/acceptance-answers-only-what-it-saw.test.ts` holds the two
 * sides to the same text.
 */
const THE_REFUSING_CHOICE = 'No, exit';
const THE_TRUSTING_CHOICE = 'Yes, I trust this folder';
const THE_CONFIRMING_LINE = 'Enter to confirm';
/** U+276F, written as an escape: a literal one in a source file is a glyph nobody can grep for by eye. */
const THE_CURSOR = '\u276F';

/**
 * The two keys this class is allowed to send, and nothing else.
 *
 * `ESC [ B` is the Down arrow of a terminal in its ordinary cursor mode, and it
 * goes out through `TerminalHandle.sendText(text, false)`, which under our own
 * engine is a raw write into the pty and appends nothing. MEASURED 2026-09-08,
 * headlessly: node-pty 1.1.0 over a ConPTY, `node` on the double started
 * directly by the pty, the three bytes written into it -- and the double received
 * them and moved its cursor from `No, exit` onto `Yes, I trust this folder`. Two
 * hops of the acceptance's own path were NOT in that measurement and are not
 * claimed here: the launcher `claude.exe`, which starts `node` with the console
 * it inherits and no redirection, and `PtyTerminalGateway`, which is the same
 * node-pty. What the measurement settles is the part nobody could argue from the
 * code: that a console in raw mode hands an arrow key through, rather than eating
 * it as line editing. `tests/fake-claude.test.ts` walks the same two keys on
 * every gate over a pipe, where there is no console at all.
 */
const A_DOWN_ARROW = '\u001B[B';
const AN_ENTER = '\r';

/** How long the cursor is given to arrive on the other choice after the arrow. */
const THE_CURSOR_MOVES_WITHIN_MS = 10_000;

/** How much of the tail is read when the question is the subject. Enough for several repaints of it. */
const SCREEN_LINES_READ = 200;

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
  /** Kept as well as its value: the gateway is asked for a handle by this, and a key needs one. */
  private readonly _terminalId: TerminalId;
  /** What the gateway said when the process ended, or `null` while it is alive. */
  private _exit: TerminalExit | null = null;

  constructor(gripterm: GriptermApi, terminalId: TerminalId) {
    this._gripterm = gripterm;
    this._id = terminalId.value;
    this._terminalId = terminalId;
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
   * What the terminal has printed, as the text a rule can be asked about.
   *
   * `null` is not "nothing was printed" -- it is "there is no screen here at
   * all", which under the `editor` engine is the permanent answer (§4.1). Every
   * caller has to separate the two, because one of them is a question about the
   * agent and the other is a question about the engine.
   */
  public whatTheScreenSays(): string | null {
    const bridge = this._gripterm.stage.bridgeFor(this._id);
    return bridge === undefined ? null : readable(bridge.tail.text, SCREEN_LINES_READ);
  }

  /**
   * Which of the two answers the cursor is on, out of the LAST repaint in the
   * tail.
   *
   * The last one is the only frame still on the screen: a prompt that repaints in
   * place leaves every earlier frame in this byte stream, and the first `❯` in it
   * is where the cursor USED to be. So the search runs from the end, and stops at
   * the first line that carries the cursor.
   *
   * `null` for all four of "no screen", "no cursor in the tail", "a cursor on
   * something this does not recognise" and "a line this cannot read one answer
   * out of", and the caller prints the screen rather than acting on any of them.
   */
  public theCursorIsOn(): 'the refusing choice' | 'the trusting choice' | null {
    const said = this.whatTheScreenSays();
    if (said === null) {
      return null;
    }
    const lines = said.split('\n');
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const line = lines[at] ?? '';
      if (!line.includes(THE_CURSOR)) {
        continue;
      }
      const trusting = line.includes(THE_TRUSTING_CHOICE);
      const refusing = line.includes(THE_REFUSING_CHOICE);
      if (trusting && refusing) {
        // BOTH on one line, which is a thing this tail can produce: it is a byte
        // stream, and a prompt that moved the cursor with escape sequences rather
        // than with a newline would leave the two choices in one line of it.
        // Answered `null` rather than by preferring one -- preferring the
        // trusting one would press Enter on `No, exit` in exactly the case this
        // class exists to stop.
        return null;
      }
      if (trusting) {
        return 'the trusting choice';
      }
      return refusing ? 'the refusing choice' : null;
    }
    return null;
  }

  /**
   * The session, up -- answering the CLI's own question first when that is what
   * is in the way.
   *
   * **The one place in this repository a key is sent to a starting terminal**, and
   * the shape of it is the correction Ш39 made. Fifteen seconds without a session
   * is not a failure: it is the condition for READING the screen. What happens
   * next is decided by what is on it, and there are four answers:
   *
   *   * the trust question of 2026-09-08 -- answered, by moving the cursor onto
   *     `Yes, I trust this folder` and confirming what the screen then says is
   *     under it;
   *   * something else -- printed, and the wait refuses with what is visible
   *     rather than sending a key at a screen nobody understands;
   *   * nothing at all -- the same;
   *   * NO SCREEN, which is the `editor` engine and is a different sentence
   *     entirely. Nothing there can see a prompt, so nothing there may answer
   *     one: the blind Enter this method replaced was exactly that, and it chose
   *     `No, exit` three runs out of three. So this refuses under `editor` and
   *     names the engine as the reason. An acceptance run of the double sets
   *     `GRIPTERM_FAKE_CLAUDE_FOLDER_IS_ALREADY_TRUSTED` there instead, which is
   *     the state a profile is in when somebody answered on an earlier day -- and
   *     it is deliberately NOT set under `own`, where the question is asked, seen
   *     and answered on every run.
   *
   * **What answering costs, against the real CLI, and it is the owner's to
   * weigh.** `Yes, I trust this folder` writes trust for the run's own temporary
   * folder into the profile of whoever ran it -- under `GRIPTERM_ACCEPTANCE_AGENT=real`
   * that is a person's own `claude` profile, which nothing here reads or tidies.
   * The alternatives are worse and were rejected out loud: `No, exit` is the
   * defect being removed, and refusing to answer at all means the acceptance can
   * never meet Claude Code in a folder it has not seen.
   */
  public async theSessionStarts(idle: () => boolean | Promise<boolean>): Promise<void> {
    const what = 'the session to start';
    if (await this.waitedFor(what, idle, A_SESSION_STARTS_WITHIN_MS) === 'reached') {
      return;
    }
    console.log(
      `${this._id}: ${A_SESSION_STARTS_WITHIN_MS.toString()} ms and no session. Reading the screen before anything is typed.`
    );
    this.showTheScreen('at 15 s, with no session yet and nothing typed');
    await this._answerTheQuestionAboutTheFolder();
    await this.until(`${what}, now that the question about the folder has been answered`, idle);
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
   * The answer, and every step of it decided by a fresh look at the screen.
   *
   * The cursor is read before the arrow AND again before the Enter. The second
   * look is the one that matters: confirming without it would be pressing Enter
   * on whatever the prompt happens to be showing, which is the whole of the
   * defect this replaced.
   */
  private async _answerTheQuestionAboutTheFolder(): Promise<void> {
    const said = this.whatTheScreenSays();
    if (said === null) {
      this._giveUp(
        'the session to start',
        'no session started inside 15 s, and this engine hands out no screen beside a handle (§4.1), so nothing here'
        + ' can tell a question from a slow start. A key is NOT being sent: sending one unseen is the defect of'
        + ' 2026-09-08, and it answered `No, exit`. Under the double, set'
        + ' GRIPTERM_FAKE_CLAUDE_FOLDER_IS_ALREADY_TRUSTED for a run with no eyes; against the real CLI, trust the'
        + ' folder once by hand and run again'
      );
    }
    if (!said.includes(THE_TRUSTING_CHOICE) || !said.includes(THE_CONFIRMING_LINE)) {
      this._giveUp(
        'the session to start',
        'no session started inside 15 s, and what the terminal printed is not the question about trusting a folder'
        + ` (it holds neither "${THE_TRUSTING_CHOICE}" nor "${THE_CONFIRMING_LINE}"). The screen is above; nothing`
        + ' was typed at it'
      );
    }
    const handle = this._gripterm.gateway.handleFor(this._terminalId);
    if (handle === undefined) {
      this._giveUp('the session to start', 'the question about the folder is on the screen and the gateway is holding no handle to answer it with');
    }

    // Looked at, and then moved only if the look says it needs moving. A prompt
    // that already had the cursor on the trusting choice would be walked OFF it
    // by an arrow sent because the measurement of 2026-09-08 said so.
    if (this.theCursorIsOn() === 'the refusing choice') {
      console.log(`${this._id}: the cursor is on "${THE_REFUSING_CHOICE}"; sending a Down arrow`);
      handle.sendText(A_DOWN_ARROW, false);
      await this.untilThere<true>(
        `the cursor to move onto "${THE_TRUSTING_CHOICE}" after the arrow`,
        () => (this.theCursorIsOn() === 'the trusting choice' ? true : null),
        THE_CURSOR_MOVES_WITHIN_MS
      );
    }

    // The second look, and the only one the Enter is allowed to be sent on.
    const under = this.theCursorIsOn();
    if (under !== 'the trusting choice') {
      this._giveUp(
        'the session to start',
        `the cursor is on ${under ?? 'nothing this can read'} rather than on "${THE_TRUSTING_CHOICE}",`
        + ' so no Enter was sent: confirming an answer nobody has read is what this method exists to stop'
      );
    }
    console.log(`${this._id}: the cursor is on "${THE_TRUSTING_CHOICE}"; confirming`);
    handle.sendText(AN_ENTER, false);
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
