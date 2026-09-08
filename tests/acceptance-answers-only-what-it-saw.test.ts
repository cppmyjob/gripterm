import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * No acceptance suite sends a key it has not looked at the screen for, and the
 * double asks the one question the real CLI asks before anything starts.
 *
 * **The defect this exists for, measured 2026-09-08 (Ш38, read in Ш39).** The
 * acceptance ran against the real `claude` 2.1.260 and the new instrument printed
 * the screen it had been sending an Enter into blind. This is what was on it:
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
 * The cursor is on `No, exit`. The four suites pressed Enter on it, so the run
 * itself was choosing "no, leave", and `claude` left with code 1 on the 17th
 * second -- three runs out of three. An instrument that sends a key without
 * reading the screen does not answer a question, it answers whichever question
 * happens to be up.
 *
 * **The second half of the same defect, and it is the worse one.** The double in
 * `tests/acceptance/fake-claude/` asked nothing before it started, by its own
 * head, so the branch that answers this question was DEAD under `fake` -- the
 * mode every acceptance run uses by default. All four criteria went green against
 * a program that skipped the first thing the real Claude Code says to an unseen
 * folder, and the answering code was only ever executed in a run that costs the
 * owner turns. So the double asks it now, and the answer is walked by every run.
 *
 * **What is asked here, and it is about four files plus two.**
 *
 *   1. **No suite carries a key of its own for a session that has not started.**
 *      The blind Enter is gone from all four, and each of them brings its session
 *      up through the ONE place that looks first
 *      (`WatchedTerminal.theSessionStarts`). A suite that kept its own answer
 *      would be a second copy of this rule that nothing checks.
 *   2. **The watcher looks before every key it sends.** Every `sendText` in
 *      `tests/acceptance/watching-a-terminal.ts` has a read of the terminal's own
 *      output within the lines just above it, and there is at least one -- so
 *      this is a rule about something rather than about an empty list.
 *   3. **The double asks the measured question, in the measured words.** The
 *      three lines the instrument steers by -- the two choices and the line that
 *      says which key confirms -- are in `fake-claude.mjs` as well, because a
 *      double that asked in different words would leave the instrument reading
 *      for a sentence nothing prints and the suites back to guessing.
 *
 * **Read as TEXT, and not imported**, for the reason its neighbour
 * `acceptance-stops-at-a-death-and-shows-the-screen.test.ts` gives: the suites
 * import the `vscode` module and open editor windows, and `fake-claude.mjs` is a
 * program that starts a session the moment it is loaded. The crudeness is in the
 * safe direction -- a suite that sends a key some third way is not seen here, and
 * one seen here really does go through the watcher.
 *
 * **What this does NOT promise.** That the cursor really moves when the arrow
 * lands: that is a fact about a pty and about the program on the other end of it,
 * and no reader of text can check it. It is measured instead -- by the acceptance
 * against the real CLI, and headlessly by
 * `tests/fake-claude.test.ts`, which drives the double's question through a pipe.
 * Nor that the words above are still the words Claude Code uses: that is what
 * `tests/acceptance/against-the-real-cli.json` and the receipt at the bottom of
 * `tests/fake-claude.test.ts` are for.
 */

const REPO = resolve(__dirname, '..');

/** Where the suites are. Listed rather than named: a fifth one is read by the same rules. */
const SUITES = join('tests', 'acceptance');

/** The one place a key may be sent from, because it is the one place that looks first. */
const WATCHER = join('tests', 'acceptance', 'watching-a-terminal.ts');

/** The double, which now asks what the real CLI asks. */
const DOUBLE = join('tests', 'acceptance', 'fake-claude', 'fake-claude.mjs');

/** How every suite brings its session up. */
const THROUGH_THE_WATCHER = 'theSessionStarts(';

/**
 * The blind Enter as all four used to write it.
 *
 * `sendText('', true)` is an empty line plus a carriage return, which is the
 * Enter that chose `No, exit` three runs out of three.
 */
const A_BLIND_ENTER = `sendText('', true)`;

/** Anything typed at a terminal. */
const SENDS_SOMETHING = 'sendText(';

/** Reading what the terminal itself has printed, in the two shapes the watcher has for it. */
const LOOKS_AT_THE_SCREEN = ['showTheScreen(', 'whatTheScreenSays(', 'theCursorIsOn('];

/** How far above a key the look may be and still be the look that key was decided by. */
const WITHIN_LINES = 12;

/**
 * The measured form, 2026-09-08, and the three lines both sides steer by.
 *
 * The instrument reads for them and the double prints them. They are written out
 * here rather than imported from either, so that a change on one side alone is a
 * red test and not a silent divergence.
 */
const THE_MEASURED_FORM = ['No, exit', 'Yes, I trust this folder', 'Enter to confirm'];

/**
 * A line that is talking about the code rather than being it.
 *
 * The rule below is about keys SENT, and both files here explain at length what
 * they used to send and why they stopped. A rule that could not tell the
 * explanation from the act would forbid the explanation -- which is the trap
 * `acceptance-stops-at-a-death-and-shows-the-screen.test.ts` names for itself
 * over `isWitnessedEnd`. Crude on purpose, and crude in the safe direction: a
 * call hidden at the end of a line that begins with a star is not seen here, and
 * nothing in either file is written that way.
 */
function isProse(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

function linesOf(file: string): readonly string[] {
  return textOf(file).split(/\r?\n/u);
}

/** Every acceptance suite, by listing the directory rather than by naming four files. */
function theSuites(): readonly string[] {
  return readdirSync(join(REPO, SUITES))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(SUITES, name));
}

/** A file that has to be there, refused with a sentence rather than with an `ENOENT`. */
function present(file: string): string {
  if (!existsSync(join(REPO, file))) {
    throw new Error(`there is no ${file}, so the rule below is about nothing`);
  }
  return textOf(file);
}

describe('the acceptance suites, which used to press Enter on `No, exit`', () => {
  it('carries no Enter of its own for a session that has not started', () => {
    const blind = theSuites()
      .flatMap((file) => linesOf(file)
        .map((line, index) => ({ file, at: index + 1, line: line.trim() }))
        .filter(({ line }) => !isProse(line) && line.includes(A_BLIND_ENTER)))
      .map(({ file, at, line }) => `${file}:${at.toString()} sends a key nothing has looked at: ${line}`);

    expect(blind).toStrictEqual([]);
  });

  it('brings its session up through the one place that looks first', () => {
    const without = theSuites().filter((file) => !textOf(file).includes(THROUGH_THE_WATCHER));

    expect(without).toStrictEqual([]);
  });

  it('is looked for at all, so that neither assertion above is about an empty list', () => {
    const suites = theSuites();

    expect(suites.length).toBeGreaterThanOrEqual(4);
    expect(suites.filter((file) => textOf(file).includes('WatchedTerminal')).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the watcher, which is the only thing here allowed to type', () => {
  it('looks at what the terminal printed before every key it sends', () => {
    const lines = linesOf(WATCHER);
    const unseen: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (isProse(line) || !line.includes(SENDS_SOMETHING)) {
        continue;
      }
      const before = lines.slice(Math.max(0, index - WITHIN_LINES), index);
      if (!before.some((one) => LOOKS_AT_THE_SCREEN.some((look) => one.includes(look)))) {
        unseen.push(
          `${WATCHER}:${(index + 1).toString()} sends a key with nothing read in the `
          + `${WITHIN_LINES.toString()} lines above it: ${line.trim()}`
        );
      }
    }

    expect(unseen).toStrictEqual([]);
  });

  it('sends the two keys the measured form needs, so that the rule above is about something', () => {
    const sends = linesOf(WATCHER).filter((line) => !isProse(line) && line.includes(SENDS_SOMETHING));

    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  it('reads the choices out of the screen rather than assuming which one the cursor is on', () => {
    const text = present(WATCHER);

    for (const line of THE_MEASURED_FORM) {
      expect(text).toContain(line);
    }
  });
});

describe('the double, which used to start without a word', () => {
  it('asks the question the real CLI asks, in the words it was measured in', () => {
    const text = present(DOUBLE);

    for (const line of THE_MEASURED_FORM) {
      expect(text).toContain(line);
    }
  });

  it('no longer says that it asks nothing before it starts', () => {
    // The claim, and not the file: a `not.toContain` on 800 lines of program
    // prints all 800 of them into the run's output when it fails.
    const stillSaysIt = present(DOUBLE).includes('asks nothing before it starts');

    expect(stillSaysIt).toBe(false);
  });
});
