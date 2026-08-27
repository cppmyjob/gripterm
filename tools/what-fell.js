'use strict';

/**
 * What fell over in a stage, read out of the output that stage already printed.
 *
 * **The defect this exists for is in this repository's own records.** On
 * 2026-08-26 `.gate/receipts.ndjson` held 26 full runs over 12 revisions, and
 * every red stage in all of them says exactly one thing: `"ok": false`. So two
 * different failures of the same stage are the same line, and the question "was
 * it this test again, or a different one" has no answer after the terminal has
 * scrolled. Both red-gate analyses of that day spent hours recovering, from
 * re-runs and from memory, a name the receipt could have kept as a string.
 *
 * **This adds nothing to what the gate knows.** The output is already produced
 * and already printed; the gate simply stopped listening to it. Nothing here
 * decides a colour, and nothing here can turn a red stage green: the receipt's
 * `ok` is still the stage's own answer, and this only writes down what the
 * stage said while giving it.
 *
 * **CommonJS, and for the reason written at the head of `tools/fork-build.js`.**
 * The gate reads this before `types` has run, which is before anything has been
 * built -- so it cannot be a compiled TypeScript module, and `tools/gate.mjs`
 * reaches it through `createRequire` exactly as it reaches the stand's judge.
 * `tests/what-fell.test.ts` reads it the same way, and the shape it expects is
 * declared there: a `.d.ts` beside this file would be a TypeScript file outside
 * `tsconfig.eslint.json`, which is a lint failure rather than a type.
 *
 * **What it deliberately does not promise.** That every format is recognised.
 * Four are: Mocha's spec reporter (the live suites and the Cursor strip),
 * Jest's default reporter (the unit stage), `tsc` and ESLint's stylish
 * formatter. Anything else comes back `null`, and the gate records that it
 * looked and could name nothing -- which is a different fact from a stage
 * nobody looked at, and is the entry that says a format wants teaching. A
 * parser that guessed would put a wrong name in a file that is read as data.
 */

/**
 * How many names one receipt line may carry.
 *
 * The file is append-only and per-machine, and it is read by loading every line
 * of it. A host that refuses to register the extension fails all 180 suites in
 * their first hook -- 180 names would be eleven kilobytes in a single line, for
 * a fact `count` states in two characters.
 */
const MOST_NAMED = 12;

/** How long one name may be. The longest real one here is 121 characters. */
const MOST_OF_A_NAME = 160;

/**
 * How much of a failure's first line is kept.
 *
 * Long enough for the one that made this necessary -- `waited 30000 ms for the
 * pseudoconsole to acknowledge a resize at all -- the bridge sent 2 sizes
 * [...], the page settled at 46x12, the pty was spawned at 80x30` is about 230
 * characters -- and short enough that a stack trace cannot follow it in.
 */
const MOST_OF_A_LINE = 400;

/** How deep a suite path may nest before a numbered block is not a failure block. */
const DEEPEST_TITLE = 8;

/** `  2 failing`, which is Mocha's own count and the anchor for everything after it. */
const MOCHA_FAILING = /^ {2}(\d+) failing\b/u;

/** `  1) a suite`, at the top level of Mocha's failure list and nowhere else. */
const MOCHA_BLOCK = /^ {2}(\d+)\) (.*)$/u;

/** `Tests:       2 failed, 1 passed, 3 total`. */
const JEST_TOTALS = /^Tests:\s+(\d+) failed/u;

/** `  1 passing (7ms)` and `  3 pending`, which is Mocha's own count of what it did and did not run. */
const MOCHA_PASSING = /^ {2}(\d+) passing/u;
const MOCHA_PENDING = /^ {2}(\d+) pending/u;

/** `Tests:       12 skipped, 1 passed, 13 total` -- every part of it, whichever parts are there. */
const JEST_TESTS = /^Tests:\s+(\S.*)$/u;
const JEST_PART = /(\d+) (skipped|todo|passed|failed|total)/gu;

/** `  ● a suite › a test`. */
const JEST_BLOCK = /^\s*● (.+)$/u;

/** Jest heads other things with the same bullet, and they are not failures. */
const NOT_A_FAILURE = new Set(['Console', 'Deprecation Warning']);

/** `path/to/file.ts(12,34): error TS2322: ...`, which is the whole of tsc's output. */
const TSC_ERROR = /^(\S[^(]*)\(\d+,\d+\): error TS\d+: /u;

/**
 * `✖ 4 problems (4 errors, 0 warnings)`.
 *
 * The bullet is matched as "whatever the first token is" rather than by its
 * character: it is written by ESLint as UTF-8 and read back through a pipe on
 * Windows, and a receipt that stopped saying anything because a code page
 * mangled one glyph would be the worst possible way to lose this.
 */
const LINT_TOTAL = /^[^\d\s]*\s*(\d+) problems? \(\d+ errors?, \d+ warnings?\)$/u;

/** `  1:7   error  'unused' is assigned a value but never used  no-unused-vars`. */
const LINT_PROBLEM = /^ {2}\d+:\d+\s+(?:error|warning)\s+\S.*$/u;

/**
 * Colour, removed before anything is read.
 *
 * Not optional and not defensive: measured 2026-08-26, Jest writes its code
 * frames in ANSI even when its stdout is a pipe with no terminal behind it, so
 * a parser that did not do this would find `[32m'says what it dropped'[39m`
 * where the test name is.
 */
function withoutColour(text) {
  // eslint-disable-next-line no-control-regex -- an ANSI escape IS a control character; there is no spelling of this that is not one
  return text.replace(/\u001B\[[0-9;]*m/gu, '');
}

/** A string cut to length, saying so, so that nothing here can grow without a bound. */
function cut(text, most) {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

/** The answer, with every bound applied in one place rather than at four call sites. */
function finish(kind, count, named, first) {
  return {
    kind,
    count,
    named: named.slice(0, MOST_NAMED).map((one) => cut(one, MOST_OF_A_NAME)),
    first: first === null ? null : cut(first, MOST_OF_A_LINE),
  };
}

/** The first line after `at` that says anything, or null. */
function nextSaying(lines, at) {
  let where = at;
  while (where < lines.length && lines[where].trim().length === 0) {
    where += 1;
  }
  return where < lines.length ? { line: lines[where].trim(), at: where } : null;
}

/**
 * One numbered failure of Mocha's, which is a suite path and then a message.
 *
 * The path is however many lines it takes, each one indented further than the
 * last, and the LAST of them ends in a colon. That colon is the only thing
 * separating the name of a test from the text of its failure, and a title that
 * ended in one of its own would be read as the end of the path -- said here
 * rather than discovered later. Nothing in this repository is named that way.
 */
function mochaBlock(lines, at, firstTitle) {
  const titles = [];
  let line = firstTitle;
  let cursor = at;
  for (let depth = 0; depth < DEEPEST_TITLE; depth += 1) {
    const trimmed = line.trim();
    if (trimmed.endsWith(':')) {
      titles.push(trimmed.slice(0, -1).trim());
      const message = nextSaying(lines, cursor + 1);
      return {
        name: titles.join(' > '),
        first: message === null ? null : message.line,
        next: message === null ? cursor + 1 : message.at,
      };
    }
    titles.push(trimmed);
    cursor += 1;
    if (cursor >= lines.length) {
      return null;
    }
    line = lines[cursor];
  }
  return null;
}

/**
 * Mocha, anchored on its own count.
 *
 * Every failure is printed TWICE -- once in the run as it happens, once in the
 * numbered list at the end -- and the two look alike enough that a parser
 * reading both would double every number. So this reads only what follows a
 * `N failing` line, and only the blocks numbered 1..N in order. That also ends
 * the list without needing to know what comes after it, which matters because
 * the live stage runs two labels one after the other and the second label's
 * run begins where the first label's failures end.
 */
function fromMocha(lines) {
  const named = [];
  let count = 0;
  let first = null;
  let anyCount = false;
  for (let at = 0; at < lines.length; at += 1) {
    const failing = MOCHA_FAILING.exec(lines[at]);
    if (failing === null) {
      continue;
    }
    anyCount = true;
    const howMany = Number(failing[1]);
    count += howMany;
    let expected = 1;
    let cursor = at + 1;
    while (expected <= howMany && cursor < lines.length) {
      const block = MOCHA_BLOCK.exec(lines[cursor]);
      const read = block === null || Number(block[1]) !== expected
        ? null
        : mochaBlock(lines, cursor, block[2]);
      if (read === null) {
        cursor += 1;
        continue;
      }
      named.push(read.name);
      if (first === null) {
        first = read.first;
      }
      expected += 1;
      cursor = read.next;
    }
    at = cursor - 1;
  }
  return anyCount && count > 0 ? finish('mocha', count, named, first) : null;
}

/** Jest, whose test names arrive as one line with its own separator in them. */
function fromJest(lines) {
  const named = [];
  let count = null;
  let first = null;
  for (let at = 0; at < lines.length; at += 1) {
    const totals = JEST_TOTALS.exec(lines[at]);
    if (totals !== null) {
      count = Number(totals[1]);
      continue;
    }
    const block = JEST_BLOCK.exec(lines[at]);
    if (block === null) {
      continue;
    }
    const title = block[1].trim();
    if (NOT_A_FAILURE.has(title)) {
      continue;
    }
    named.push(title.split(' › ').join(' > '));
    if (first === null) {
      const message = nextSaying(lines, at + 1);
      first = message === null ? null : message.line;
    }
  }
  if (named.length === 0 && count === null) {
    return null;
  }
  return finish('jest', count === null ? named.length : count, named, first);
}

/**
 * The compiler, which has files where the two above have tests.
 *
 * The files ARE the answer here, and they are what goes in `named`: a receipt
 * that said only "9 errors" would leave the reader exactly where `ok: false`
 * left them. `count` is the errors, because that is what tsc counts.
 */
function fromTypes(lines) {
  const files = [];
  let count = 0;
  let first = null;
  for (const line of lines) {
    const error = TSC_ERROR.exec(line);
    if (error === null) {
      continue;
    }
    count += 1;
    if (first === null) {
      first = line.trim();
    }
    if (!files.includes(error[1])) {
      files.push(error[1]);
    }
  }
  return count === 0 ? null : finish('types', count, files, first);
}

/**
 * The linter, and `count` is its PROBLEMS rather than its errors.
 *
 * `pnpm run lint` runs with `--max-warnings 0`, so a warning is as red as an
 * error and a count that left warnings out would report zero over a stage that
 * had just failed.
 */
function fromLint(lines) {
  const files = [];
  let count = null;
  let first = null;
  let file = null;
  for (const line of lines) {
    const total = LINT_TOTAL.exec(line);
    if (total !== null) {
      count = Number(total[1]);
      continue;
    }
    if (!LINT_PROBLEM.test(line)) {
      if (line.trim().length > 0 && !line.startsWith(' ')) {
        file = line.trim();
      }
      continue;
    }
    if (first === null) {
      first = line.trim();
    }
    if (file !== null && !files.includes(file)) {
      files.push(file);
    }
  }
  return count === null || count === 0 ? null : finish('lint', count, files, first);
}

/**
 * How many tests a Mocha run did not execute, out of its own summary.
 *
 * **The absence of a `pending` line is the answer NOUGHT and not silence**, and
 * that is the whole subtlety here. Mocha prints `N pending` only when N is not
 * nought, so a parser that required the line in order to answer would report
 * "did not say" over every green run in this repository -- which is the exact
 * reading this was written to remove.
 *
 * Summed across the whole transcript rather than read once: the `live` stage
 * runs two labels one after the other and prints two summaries, and a reader
 * asking what a green stage skipped is asking about the stage.
 */
function didNotRunMocha(lines) {
  let passing = 0;
  let pending = 0;
  let failing = 0;
  let any = false;
  for (const line of lines) {
    const passed = MOCHA_PASSING.exec(line);
    if (passed !== null) {
      passing += Number(passed[1]);
      any = true;
      continue;
    }
    const skipped = MOCHA_PENDING.exec(line);
    if (skipped !== null) {
      pending += Number(skipped[1]);
      continue;
    }
    const failed = MOCHA_FAILING.exec(line);
    if (failed !== null) {
      failing += Number(failed[1]);
    }
  }
  // Anchored on `passing`, which Mocha prints on every run including one where
  // everything failed (`0 passing`). A transcript with a `pending` line and no
  // `passing` line is not a Mocha summary; it is a coincidence.
  return any ? { kind: 'mocha', skipped: pending, total: passing + pending + failing } : null;
}

/**
 * How many tests a Jest run did not execute, out of its totals line.
 *
 * `todo` is counted with `skipped`, deliberately. Jest keeps them apart because
 * they were written differently -- `it.todo` has no body, `it.skip` has one
 * nobody ran -- and the person reading a green gate is asking one question about
 * both: what did this not check.
 */
function didNotRunJest(lines) {
  for (const line of lines) {
    const totals = JEST_TESTS.exec(line);
    if (totals === null) {
      continue;
    }
    let skipped = 0;
    let total = null;
    JEST_PART.lastIndex = 0;
    let part = JEST_PART.exec(totals[1]);
    while (part !== null) {
      const how = Number(part[1]);
      if (part[2] === 'skipped' || part[2] === 'todo') {
        skipped += how;
      } else if (part[2] === 'total') {
        total = how;
      }
      part = JEST_PART.exec(totals[1]);
    }
    if (total !== null) {
      return { kind: 'jest', skipped, total };
    }
  }
  return null;
}

/**
 * How many of a stage's tests did not run, or null where its output does not say.
 *
 * **The defect this exists for, 2026-08-27.** The gate printed a colour and a
 * time beside each stage and nothing about what that stage had switched off, so
 * a green stage holding twenty disabled tests read exactly like a green stage
 * holding none. This adds nothing to what the gate knows -- the runners already
 * printed it and the gate already captured it; it simply stopped listening,
 * which is the same defect `whatFell` was written for one day earlier.
 *
 * **Null is not nought and the gate must print them differently.** A stage whose
 * output no runner wrote -- `tsc`, ESLint, the stand's own driver, the eyes' --
 * cannot be asked this question, and answering `0` for it would be a number
 * nobody measured standing where a measured one goes (I.1).
 *
 * @param {string} said everything the stage wrote to stdout and stderr
 * @returns {{kind: string, skipped: number, total: number}|null}
 */
function whatDidNotRun(said) {
  const lines = withoutColour(said).split(/\r?\n/u);
  return didNotRunMocha(lines) ?? didNotRunJest(lines);
}

/**
 * What a stage's output says fell over, or null where nothing here recognises it.
 *
 * @param {string} said everything the stage wrote to stdout and stderr
 * @returns {{kind: string, count: number|null, named: string[], first: string|null}|null}
 */
function whatFell(said) {
  const lines = withoutColour(said).split(/\r?\n/u);
  return fromMocha(lines) ?? fromJest(lines) ?? fromTypes(lines) ?? fromLint(lines) ?? null;
}

/**
 * Everything a stage said, minus the oldest of it once there is too much.
 *
 * **The oldest and not the newest, and that is the whole design.** Mocha prints
 * its failures at the END, Jest prints its totals at the end, and ESLint prints
 * its count at the end. A transcript that filled up and stopped listening would
 * keep four minutes of passing tests and drop the one thing it was kept for.
 *
 * What it costs, said plainly: after a drop, `first` means "the first failure
 * still in the transcript" and not "the first failure of the run", and the
 * count may come from a summary whose own detail was dropped. `dropped()` is
 * how the gate knows to say so.
 *
 * @param {number} most how many characters may be held
 */
function transcript(most) {
  const parts = [];
  let held = 0;
  let lost = 0;
  return {
    say(text) {
      if (text.length === 0) {
        return;
      }
      // A single chunk over the bound is cut to its own tail first, so that one
      // enormous write cannot make the transcript bigger than the bound it was
      // given. A pty under a flood produces exactly that.
      const fits = text.length > most ? text.slice(text.length - most) : text;
      lost += text.length - fits.length;
      parts.push(fits);
      held += fits.length;
      while (held > most && parts.length > 1) {
        const gone = parts.shift();
        held -= gone.length;
        lost += gone.length;
      }
    },
    said() {
      return parts.join('');
    },
    dropped() {
      return lost;
    },
  };
}

module.exports = { transcript, whatDidNotRun, whatFell };
