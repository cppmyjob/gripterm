import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * No acceptance suite waits longer for a conversation than its process lives,
 * and no acceptance suite refuses without showing what that process printed.
 *
 * **The defect this exists for, measured 2026-09-08 (Ш38).** The acceptance ran
 * against the real `claude` 2.1.260 for the first time in this repository's
 * history and went red on both engines. Under `own` the suite said
 * `gave up waiting for the session to start after 90000 ms`. The window's own
 * log of the same run says something else:
 *
 * ```
 * 14:40:59.855  a terminal was started  {engine: own, intent: launch}
 * 14:41:16.678  a terminal closed       {"exitCode":1,"reason":"process",
 *                                        "event":"LaunchExitedNonZero"}
 * ```
 *
 * The process died on the 17th second with code 1, and the suite went on waiting
 * for `idle` for another 73 seconds before reporting a cause that was not the
 * cause. That is not a slow test: it is an instrument that watched the record's
 * STATE, could not see the process behind it, and named the deadline as the
 * reason. The four suites had one more thing in common -- none of them had ever
 * looked at what the terminal PRINTED, which under the `own` engine this
 * repository keeps in full.
 *
 * **What is asked here, and it is two questions about four files.**
 *
 *   1. **No suite waits by the clock alone.** Every wait a suite makes goes
 *      through `tests/acceptance/watching-a-terminal.ts`, which ends the wait as
 *      soon as the gateway reports that the PROCESS behind the terminal exited,
 *      and names the code and the reason instead of a deadline. A suite that
 *      builds a deadline of its own is a wait this rule cannot see inside, so it
 *      may not have one.
 *   2. **A refusal shows the screen.** The watcher throws in exactly one place,
 *      and that place prints the tail first -- or, under the `editor` engine
 *      where no handle has a screen, says in one line that there is none. And the
 *      tail is taken at the one moment no refusal covers: the 15th second, when a
 *      session has not started and something is about to be decided about it.
 *      **That look used to be in each of the four suites, immediately before the
 *      blind Enter they sent there. Ш39 read the frame it printed, found the
 *      cursor sitting on `No, exit`, and moved both the look and the answer into
 *      `WatchedTerminal.theSessionStarts` -- one place, which reads the screen and
 *      answers what is on it.** So this rule now asks the watcher for that look
 *      rather than the suites, and what the suites are held to is that they carry
 *      no key of their own at all:
 *      `tests/acceptance-answers-only-what-it-saw.test.ts`.
 *
 * **THE PROCESS, NEVER THE RECORD, AND THAT WAS SETTLED BY A REFUTATION.** The
 * obvious predicate -- `isWitnessedEnd(entry.observed.state)` -- is forbidden
 * here, and this rule set would not exist in this shape without the reason: the
 * record's `ended` means the CONVERSATION ended, and `/clear` walks a healthy
 * terminal through it and out the other side (`TerminalStateMachine`'s
 * resurrection edge). A refusal on the record would have turned
 * `p3-clear.test.ts` red on a terminal that was never in any trouble, most runs.
 * `TerminalHandle.onDidClose` is the only witness of the PROCESS, it exists on
 * both engines, and nothing brings a pty back.
 *
 * **WHAT THE PRINTED SCREEN IS, so that the next reader does not take it for
 * one.** It is the tail of the byte stream the process wrote -- escape sequences
 * and all, every repaint one after another -- bounded at 200 000 UTF-16 code
 * units, with a count of what fell off the front. It is NOT a rendered frame:
 * nothing here runs a terminal emulator over it, and the rendering the watcher
 * prints (escapes dropped, carriage returns broken into lines) is a readable
 * approximation. It answers "is there text about trusting this folder in what
 * the CLI printed", which is the question it was built for. It does not answer
 * "what did the screen look like".
 *
 * **Read as TEXT, and not imported**, for the reason its neighbours give:
 * `tests/acceptance/*.test.ts` import the `vscode` module and open editor
 * windows, and `tests/acceptance/run.mjs` spends a real turn. The same crudeness
 * in the same safe direction -- a suite that waits some other way is not seen
 * here, and one seen here really does wait through the watcher.
 *
 * **What this does NOT promise, said plainly because a text rule is weak.** That
 * the watcher's refusal reaches a screen with anything on it: what is printed is
 * the panel's bridge tail, and whether the bridge is there is a fact about a
 * running window that no reader of text can check. That a suite cannot wait by
 * some other clock -- a counted loop would pass this and hang. That a fifth
 * suite written tomorrow in some third shape is covered. What is covered is the
 * shape all four are in, and a fifth suite is read by the same rules because the
 * list below is a directory listing rather than a list of names.
 */

const REPO = resolve(__dirname, '..');

/** Where the suites are. Listed rather than named: a fifth one is read by the same rules. */
const SUITES = join('tests', 'acceptance');

/** The one thing all four wait through. */
const WATCHER = join('tests', 'acceptance', 'watching-a-terminal.ts');

/** How a suite reaches it. */
const THE_WATCHER = `from './watching-a-terminal'`;

/**
 * A deadline built or compared in a suite of its own.
 *
 * Both directions, because `deadline > Date.now()` is the same wait written
 * backwards. Subtraction is deliberately NOT here: `Date.now() - startedAt` is a
 * suite saying how long something took, which is a measurement rather than a
 * wait.
 */
const A_DEADLINE_OF_ITS_OWN = /Date\.now\(\)\s*[+<>]|[<>]=?\s*Date\.now\(\)/u;

/**
 * How every suite brings its session up, and the one place the 15-second look
 * lives since Ш39.
 *
 * It used to be four copies of a look followed by a blind Enter. The Enter chose
 * `No, exit`, and both halves moved into the watcher; the suites now call this
 * and carry no key at all.
 */
const THROUGH_THE_WATCHER = 'theSessionStarts(';

/** The look at the frame that no refusal covers, as the watcher labels it. */
const THE_LOOK_AT_FIFTEEN_SECONDS = `showTheScreen('at 15 s`;

/** What a suite calls to put the terminal's own output on the run's output. */
const SHOWS_THE_SCREEN = 'showTheScreen(';

/**
 * How far above a refusal the screen may be taken and still be the frame that
 * refusal is about.
 *
 * It used to measure the same distance above the blind Enter in each of the four
 * suites; since Ш39 there is no such Enter, and the one remaining reader is
 * the rule about the watcher's single `throw`.
 */
const WITHIN_LINES = 6;

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/** Every acceptance suite, by listing the directory rather than by naming four files. */
function theSuites(): readonly string[] {
  return readdirSync(join(REPO, SUITES))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(SUITES, name));
}

/**
 * The watcher's own text.
 *
 * Absent is a failure with a sentence rather than an `ENOENT`: until this file
 * exists there is nothing for the suites to wait through, which is the whole of
 * what these rules are about.
 */
function theWatcher(): string {
  if (!existsSync(join(REPO, WATCHER))) {
    throw new Error(`there is no ${WATCHER}, so the suites have nothing to wait through and no screen to print`);
  }
  return textOf(WATCHER);
}

/** The lines of a file, so that "near" can be asked about. */
function linesOf(file: string): readonly string[] {
  return textOf(file).split(/\r?\n/u);
}

describe('the acceptance suites, which used to wait 73 seconds for a process that had died', () => {
  it('waits through the watcher, every one of them', () => {
    const without = theSuites().filter((file) => !textOf(file).includes(THE_WATCHER));

    expect(without).toStrictEqual([]);
  });

  it('builds no deadline of its own, so that no wait of theirs is by the clock alone', () => {
    const byTheClock = theSuites()
      .flatMap((file) => linesOf(file)
        .map((line, index) => ({ file, line: line.trim(), at: index + 1 }))
        .filter(({ line }) => A_DEADLINE_OF_ITS_OWN.test(line)))
      .map(({ file, line, at }) => `${file}:${at.toString()} waits by its own clock: ${line}`);

    expect(byTheClock).toStrictEqual([]);
  });

  it('takes the screen at the fifteenth second, in the one place that now does it for all four', () => {
    expect(theWatcher()).toContain(THE_LOOK_AT_FIFTEEN_SECONDS);
  });

  it('is looked for at all, so that no assertion above is about an empty list', () => {
    const suites = theSuites();
    const throughTheWatcher = suites.filter((file) => textOf(file).includes(THROUGH_THE_WATCHER));

    expect(suites.length).toBeGreaterThanOrEqual(4);
    expect(throughTheWatcher.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the watcher those suites wait through', () => {
  it('ends a wait on the gateway`s own word that the process exited', () => {
    const text = theWatcher();

    expect(text).toContain('onDidClose');
    expect(text).toContain('TerminalExit');
  });

  it('refuses on the process and never on the record, which `/clear` walks through', () => {
    // What the module IMPORTS, which is everything above its own head comment.
    // The rule is about the imports rather than about the word: the watcher
    // explains at length why `isWitnessedEnd` is the wrong question here, and a
    // rule that forbade the word would forbid the explanation. A call is
    // impossible without an import, and an import is a thing a reader of text
    // can see.
    const lines = theWatcher().split(/\r?\n/u);
    const head = lines.findIndex((line) => line.startsWith('/**'));
    const imports = lines.slice(0, head === -1 ? lines.length : head);

    expect(imports.filter((line) => line.includes('isWitnessedEnd'))).toStrictEqual([]);
    expect(imports.filter((line) => line.startsWith('import')).length).toBeGreaterThanOrEqual(1);
  });

  it('names the exit code and the reason, which is what the deadline could not', () => {
    const text = theWatcher();

    expect(text).toContain('exit code');
    expect(text).toContain('reason');
  });

  it('refuses in one place only, and shows the screen before it does', () => {
    const lines = theWatcher().split(/\r?\n/u);
    const throws = lines
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) => line.includes('throw new Error'));

    expect(throws).toHaveLength(1);

    const [only] = throws;
    const at = only?.at ?? 1;
    const before = lines.slice(Math.max(0, at - 1 - WITHIN_LINES), at - 1);
    expect(before.some((one) => one.includes(SHOWS_THE_SCREEN))).toBe(true);
  });

  it('takes the screen from the panel`s own bridge, and says so when there is none', () => {
    const text = theWatcher();

    expect(text).toContain('bridgeFor');
    expect(text).toContain(`'editor'`);
  });
});
