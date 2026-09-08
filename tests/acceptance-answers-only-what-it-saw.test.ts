import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readable, theChoiceUnderTheCursor, whatToDoAboutTheScreen } from './acceptance/watching-a-terminal';

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
 * **The suites and the double are read as TEXT and never imported**, for the
 * reason its neighbour `acceptance-stops-at-a-death-and-shows-the-screen.test.ts`
 * gives: the suites import the `vscode` module and open editor windows, and
 * `fake-claude.mjs` is a program that starts a session the moment it is loaded.
 * The crudeness is in the safe direction -- a suite that sends a key some third
 * way is not seen here, and one seen here really does go through the watcher.
 *
 * **The watcher's own reading of a screen IS imported**, and that is not the same
 * decision: `readable` and `theChoiceUnderTheCursor` are pure functions of a
 * string, the module they live in imports nothing at run time but types, and a
 * text rule over them would say nothing about the only question that matters --
 * what they make of the bytes a real Claude Code sent. Those bytes are below.
 *
 * **What the text rules do NOT promise, and what was measured instead.** That the
 * cursor really moves when the arrow lands is a fact about a pty and about the
 * program on the other end of it, and no reader of text can check it. IT IS
 * MEASURED, twice and on the same day: against the real `claude` 2.1.260 under
 * the `own` engine, where the instrument sent the arrow and THE CLI OBEYED -- the
 * frame it drew in answer is `WHAT_THE_REAL_CLI_REDREW` below -- and headlessly
 * through node-pty over a ConPTY against the double, whose own frame is beside
 * it. `tests/fake-claude.test.ts` drives the same two keys through a pipe on
 * every gate.
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
const THE_REFUSING_CHOICE = 'No, exit';
const THE_TRUSTING_CHOICE = 'Yes, I trust this folder';
const THE_CONFIRMING_LINE = 'Enter to confirm';
const THE_MEASURED_FORM = [THE_REFUSING_CHOICE, THE_TRUSTING_CHOICE, THE_CONFIRMING_LINE];

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

/**
 * ESC, so that the frames below can be written the way they were quoted.
 *
 * A literal control character in a source file is invisible to a reader and to a
 * `grep`, and these two strings are evidence: they have to be legible.
 */
const ESC = '\u001B';

/**
 * THE FRAME THE REAL CLI DREW AFTER THE ARROW, 2026-09-08, CLI 2.1.260.
 *
 * Copied from the tail of an acceptance run against the real `claude` under the
 * `own` engine -- the run in which the instrument read the first frame right,
 * said `the cursor is on "No, exit"; sending a Down arrow`, sent it, and then
 * refused after ten seconds although THE CURSOR HAD MOVED. It could not see that
 * it had: the repaint addresses rows with `ESC [ <row> ; 2 H` instead of
 * newlines, and separates the marker from its text with `ESC [ 1 C` instead of a
 * space, and the rendering dropped both -- so the two answers arrived as one
 * unreadable line, ` No, exit(cursor)Yes, I trust this folder`.
 *
 * It is a test now rather than a corrected line of code, because a rendering that
 * cannot read the real thing is exactly what a green suite hides.
 */
const WHAT_THE_REAL_CLI_REDREW =
  `${ESC}[?2026h${ESC}[?2026l${ESC}[10;2H ${ESC}[1CNo, exit`
  + `${ESC}[38;2;177;185;249m${ESC}[11;2H❯${ESC}[1CYes, I trust this folder${ESC}[m`;

/**
 * The same frame from the double, measured through a pty on the same day.
 *
 * node-pty 1.1.0 over a ConPTY, `node` on `fake-claude.mjs`, `ESC [ B` written
 * into it. The rows differ from the real CLI's on purpose and the difference is
 * explained at `CHOICES_START_AT_ROW` in that file: 10 and 11 were where the real
 * prompt sat on that screen, which is not a rule. Everything a reader has to get
 * through is the same, and this is the assertion that keeps it so.
 */
const WHAT_THE_DOUBLE_REDRAWS =
  `${ESC}[?25l${ESC}[7;2H ${ESC}[1CNo, exit${ESC}[8;2H❯${ESC}[1CYes, I trust this folder${ESC}[?25h`;

describe('the frames those two drew, replayed into the reading that failed on one of them', () => {
  it('reads the trusting choice out of what the real CLI redrew', () => {
    expect(theChoiceUnderTheCursor(readable(WHAT_THE_REAL_CLI_REDREW, 200))).toBe('the trusting choice');
  });

  it('reads the same out of what the double redraws, which is the point of the double', () => {
    expect(theChoiceUnderTheCursor(readable(WHAT_THE_DOUBLE_REDRAWS, 200))).toBe('the trusting choice');
  });

  it('puts the two answers on two lines, which is what the old rendering could not', () => {
    const shown = readable(WHAT_THE_REAL_CLI_REDREW, 200).split('\n');

    expect(shown).toStrictEqual(['  No, exit', '❯ Yes, I trust this folder']);
  });

  it('reads the refusing choice while the cursor is still on it, so that the arrow is sent at all', () => {
    const first = `${ESC}[38;2;177;185;249m❯ No, exit${ESC}[m` + '\n' + '   Yes, I trust this folder';

    expect(theChoiceUnderTheCursor(readable(first, 200))).toBe('the refusing choice');
  });
});

/**
 * U+276F, the marker the prompt puts against the answer it is on.
 *
 * Written as an escape for the reason `watching-a-terminal.ts` gives at its own
 * copy: a literal one in a source file is a glyph nobody can grep for by eye.
 * The two byte frames above keep theirs literal because they are quoted
 * evidence; everything below is built, and builds it from here.
 */
const THE_CURSOR_GLYPH = '\u276F';

/** U+00B7, the separator the confirming line was measured with. */
const A_MIDDLE_DOT = '\u00B7';

/** As many lines of the tail as `WatchedTerminal.whatTheScreenSays` reads. */
const LINES_READ = 200;

/**
 * The whole block, as BOTH sides draw it the first time.
 *
 * MEASURED 2026-09-08, CLI 2.1.260: this is the tail the instrument printed on
 * the 15th second, quoted at the head of this file and at the head of
 * `tests/acceptance/watching-a-terminal.ts`. It is the RENDERING and not the
 * bytes, and that is said out loud -- of that FIRST drawing this repository holds
 * no bytes at all, and of the REPAINT it holds `WHAT_THE_REAL_CLI_REDREW` and
 * `WHAT_THE_DOUBLE_REDRAWS` above. The cases below therefore ask both: this block
 * alone, and this block with those bytes on top of it, which is the tail a run
 * really holds after its own arrow.
 *
 * One argument, and the two sides differ only in it: the folder each was looking
 * at. That is not a shortcut -- `fake-claude.mjs` copies these words on purpose,
 * and the rules above are what hold it to them.
 */
function theWholeQuestion(workspace: string): string {
  return [
    `Accessing workspace: ${workspace}`,
    'Quick safety check: Is this a project you created or one you trust?',
    '(Like your own code, a well-known open source project, or work from your team).',
    `If not, take a moment to review what's in this folder first.`,
    `Claude Code'll be able to read, edit, and execute files here.`,
    'Security guide',
    ` ${THE_CURSOR_GLYPH} ${THE_REFUSING_CHOICE}`,
    `   ${THE_TRUSTING_CHOICE}`,
    ` ${THE_CONFIRMING_LINE} ${A_MIDDLE_DOT} Esc to cancel`,
  ].join('\n');
}

/** The real CLI's, with the workspace line as that run printed it. */
const WHAT_THE_REAL_CLI_ASKED = theWholeQuestion(String.raw`c:\...\gripterm-acceptance\project`);

/** The double's, whose folder is unique per run since Ш42 and whose words are not. */
const WHAT_THE_DOUBLE_ASKS = theWholeQuestion(String.raw`C:\...\Temp\gripterm-acceptance\project-<this run's uuid>`);

/**
 * The same block, cut where the marker had not been drawn yet.
 *
 * THE CASE THE EARLY LOOK IS ABOUT. Until Ш42 the frame was read once, at the
 * 15-second mark, and was therefore certain to be finished. It is read as soon as
 * it can be read now, which means it can be read mid-drawing -- and the answering
 * step REFUSES on a half-drawn one, with `the cursor is on nothing this can read`
 * or with `what the terminal printed is not the question`. A long green would
 * have become a fast red.
 */
function cutBeforeTheCursorWasPlaced(frame: string): string {
  return frame.slice(0, frame.indexOf(THE_CURSOR_GLYPH));
}

/**
 * And cut one chunk later: the marker is placed, both answers are on the screen,
 * and the block is still not finished.
 *
 * The line that says which key confirms is written LAST of the four things the
 * instrument steers by, so a tail holding it holds the whole block. This is the
 * cut that tells a weaker condition from the one this file asks for: "both
 * answers and a readable marker" alone would answer here, and the answering step
 * would then refuse -- its own first look wants that line.
 */
function cutBeforeTheBlockWasFinished(frame: string): string {
  return frame.slice(0, frame.indexOf(THE_CONFIRMING_LINE));
}

/**
 * The frame the OLD rendering made of the repaint, kept because it is measured.
 *
 * 2026-09-08: the repaint addressed its rows with escape sequences instead of
 * newlines, `readable` dropped them, and the two answers arrived as ONE line --
 * ` No, exit(cursor)Yes, I trust this folder`, the last printable line of the run
 * that refused. `readable` breaks rows now, so that repaint does not produce this
 * shape any more; it is the shape a frame this code cannot read still has, and
 * `theChoiceUnderTheCursor` answers `null` for it rather than guessing which of
 * the two answers the marker belongs to. A screen like that has to be waited on
 * and never answered: guessing the trusting one would press Enter on `No, exit`,
 * which is the defect all of this exists to stop.
 */
const WHAT_A_FRAME_NOBODY_CAN_READ_LOOKS_LIKE = [
  ` ${THE_CONFIRMING_LINE} ${A_MIDDLE_DOT} Esc to cancel`,
  ` ${THE_REFUSING_CHOICE}${THE_CURSOR_GLYPH}${THE_TRUSTING_CHOICE}`,
].join('\n');

/**
 * One row of a repaint, with the row beside it not on the tail.
 *
 * Built in the shape the repaints above were measured in -- an absolute row
 * address, the marker, a column advance, the text -- and it is the case that says
 * what "BOTH answers" is for. Everything the answering step itself asks of a
 * frame is here: the line that says which key confirms, and a marker this can
 * read on an answer it knows. The choice block still is not on the screen, and a
 * condition that stopped at what the answering step asks would act on this.
 */
function halfARepaintShowingOnly(choice: string): string {
  return ` ${THE_CONFIRMING_LINE} ${A_MIDDLE_DOT} Esc to cancel`
    + `${ESC}[8;2H${THE_CURSOR_GLYPH}${ESC}[1C${choice}`;
}

/** The tail as `WatchedTerminal.whatTheScreenSays` hands it to the decision. */
function theFrame(bytes: string): string {
  return readable(bytes, LINES_READ);
}

describe('the decision the wait makes, now that it looks at the screen before the deadline', () => {
  it('answers the whole frame the real CLI drew', () => {
    expect(whatToDoAboutTheScreen(theFrame(WHAT_THE_REAL_CLI_ASKED), false)).toBe('answer what is on the screen');
  });

  it('answers that frame with the real CLI`s own repaint on top, which is the tail after an arrow', () => {
    const tail = theFrame(WHAT_THE_REAL_CLI_ASKED + WHAT_THE_REAL_CLI_REDREW);

    expect(whatToDoAboutTheScreen(tail, false)).toBe('answer what is on the screen');
    expect(theChoiceUnderTheCursor(tail)).toBe('the trusting choice');
  });

  it('answers the whole frame the double draws', () => {
    expect(whatToDoAboutTheScreen(theFrame(WHAT_THE_DOUBLE_ASKS), false)).toBe('answer what is on the screen');
  });

  it('answers that frame with the double`s own repaint on top', () => {
    const tail = theFrame(WHAT_THE_DOUBLE_ASKS + WHAT_THE_DOUBLE_REDRAWS);

    expect(whatToDoAboutTheScreen(tail, false)).toBe('answer what is on the screen');
    expect(theChoiceUnderTheCursor(tail)).toBe('the trusting choice');
  });

  it('WAITS on the real CLI`s frame cut before the marker was drawn, rather than refusing on it', () => {
    const cut = theFrame(cutBeforeTheCursorWasPlaced(WHAT_THE_REAL_CLI_ASKED));

    expect(whatToDoAboutTheScreen(cut, false)).toBe('wait');
    // What refusing on it would have been: the answering step reads this same
    // tail, finds neither the trusting answer nor the confirming line, and says
    // so. That refusal is right at the deadline and wrong before it.
    expect(cut).not.toContain(THE_TRUSTING_CHOICE);
    expect(cut).not.toContain(THE_CONFIRMING_LINE);
    expect(theChoiceUnderTheCursor(cut)).toBeNull();
  });

  it('WAITS on the double`s frame cut at the same place', () => {
    expect(whatToDoAboutTheScreen(theFrame(cutBeforeTheCursorWasPlaced(WHAT_THE_DOUBLE_ASKS)), false)).toBe('wait');
  });

  it('waits on a frame whose block is unfinished, although both answers and the marker are on it', () => {
    const cut = theFrame(cutBeforeTheBlockWasFinished(WHAT_THE_REAL_CLI_ASKED));

    expect(whatToDoAboutTheScreen(cut, false)).toBe('wait');
    expect(cut).toContain(THE_REFUSING_CHOICE);
    expect(cut).toContain(THE_TRUSTING_CHOICE);
    expect(theChoiceUnderTheCursor(cut)).toBe('the refusing choice');
  });

  it('waits on half a repaint that shows only the trusting answer, although its marker reads perfectly', () => {
    const half = theFrame(halfARepaintShowingOnly(THE_TRUSTING_CHOICE));

    expect(whatToDoAboutTheScreen(half, false)).toBe('wait');
    expect(half).not.toContain(THE_REFUSING_CHOICE);
    expect(half).toContain(THE_CONFIRMING_LINE);
    expect(theChoiceUnderTheCursor(half)).toBe('the trusting choice');
  });

  it('waits on the other half of it, which shows only the refusing answer', () => {
    const half = theFrame(halfARepaintShowingOnly(THE_REFUSING_CHOICE));

    expect(whatToDoAboutTheScreen(half, false)).toBe('wait');
    expect(half).not.toContain(THE_TRUSTING_CHOICE);
    expect(half).toContain(THE_CONFIRMING_LINE);
    expect(theChoiceUnderTheCursor(half)).toBe('the refusing choice');
  });

  it('waits on a frame nobody can read the marker out of, rather than guessing which answer it is on', () => {
    const unreadable = theFrame(WHAT_A_FRAME_NOBODY_CAN_READ_LOOKS_LIKE);

    expect(whatToDoAboutTheScreen(unreadable, false)).toBe('wait');
    expect(unreadable).toContain(THE_REFUSING_CHOICE);
    expect(unreadable).toContain(THE_TRUSTING_CHOICE);
    expect(unreadable).toContain(THE_CONFIRMING_LINE);
    expect(theChoiceUnderTheCursor(unreadable)).toBeNull();
  });

  it('waits where there is no screen at all, which is the editor engine and is not a refusal', () => {
    expect(whatToDoAboutTheScreen(null, false)).toBe('wait');
  });

  it('waits on a tail with nothing printable in it', () => {
    expect(whatToDoAboutTheScreen(theFrame(''), false)).toBe('wait');
  });

  it('lets the session win over every one of those frames, so that nothing is typed at a terminal that started', () => {
    const frames = [
      theFrame(WHAT_THE_REAL_CLI_ASKED),
      theFrame(WHAT_THE_DOUBLE_ASKS),
      theFrame(cutBeforeTheCursorWasPlaced(WHAT_THE_REAL_CLI_ASKED)),
      theFrame(WHAT_A_FRAME_NOBODY_CAN_READ_LOOKS_LIKE),
    ];

    expect(frames.map((frame) => whatToDoAboutTheScreen(frame, true))).toStrictEqual(frames.map(() => 'the session is up'));
    expect(whatToDoAboutTheScreen(null, true)).toBe('the session is up');
  });
});

/**
 * Where the runner decides which folder it opens.
 *
 * **The defect this exists for, measured 2026-09-08 (Ш42).** Against the real
 * `claude` the acceptance ran five times that day and not one of those runs was
 * asked about trusting its folder: no `the cursor is on ...` line anywhere, and a
 * terminal up in about 8 s against the 22.4 s of the run earlier the same day
 * where the question WAS asked. The cause is in `tests/acceptance/run.mjs`, where
 * `PROJECT` was a constant path and where `CLAUDE_CONFIG_DIR` is deliberately NOT
 * moved under `GRIPTERM_ACCEPTANCE_AGENT=real`: a "yes, I trust this folder"
 * answered once went into the profile of whoever ran it and stayed there, for
 * that path, for good. So the answering path Ш39 built could never be walked
 * against Claude Code again on that machine -- the instrument was built and made
 * uncheckable on the same day.
 *
 * **Read as TEXT, and weak on purpose.** This says the path is not a constant. It
 * cannot say that a run really gets a folder the CLI has not seen, which is a
 * fact about somebody's profile and about a directory nothing here may look in.
 * That half is a run against the real CLI and it is the orchestrator's to make.
 * Crude in the safe direction, as its neighbours are: a path made unique some
 * other way is not seen here, and one seen here really is unique.
 */
const THE_RUNNER = join('tests', 'acceptance', 'run.mjs');

/** The line that decides it. */
const THE_PROJECT_LINE = /^const PROJECT = .*$/mu;

/** What a path unique per run is made of, and it was already imported there. */
const A_FRESH_NAME = 'randomUUID';

describe('the folder the acceptance opens, which a profile remembers being told to trust', () => {
  it('decides it in one line, so that the rule below is about something', () => {
    expect(present(THE_RUNNER)).toMatch(THE_PROJECT_LINE);
  });

  it('does not open the same path on every run', () => {
    const [line] = THE_PROJECT_LINE.exec(present(THE_RUNNER)) ?? [];

    expect(line).toBeDefined();
    expect(line).toContain(A_FRESH_NAME);
  });
});
