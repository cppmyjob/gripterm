import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The gate: the one run this repository is allowed to call "checked".
 *
 * **Why it exists.** There is no CI here (`.github` does not exist, measured
 * 2026-08-25) and there was no hook before this step: measured the same day,
 * `core.hooksPath` was unset AND `.git/hooks` held nothing but git's own
 * `.sample` files. Two facts, because `core.hooksPath` alone establishes
 * neither -- unset means the default directory, not an empty one. A hook is
 * there now, installed 2026-08-25 by hand from `tools/pre-push.sh`, and it is
 * per-machine: a fresh clone has none. Every suite was a thing somebody could remember to run, and the
 * acceptance stand was behind an environment variable, which is to say it never
 * ran at all. A check nobody is obliged to run is a check that reports what the
 * last person felt like checking.
 *
 * **Two levels, and the reason they are two.** `--fast` is types, lint and the
 * unit suites: measured 51 s on 2026-08-25, no editor, no window, nothing on
 * anyone's desktop. The full gate adds the live suites in a real editor and the
 * two-sitting stand, which opens four windows; measured 7 min 30 s end to end.
 *
 * The split is not about taste. `pre-push` runs the fast level, and the rule for
 * what belongs in a hook is: a stage whose failure means "this must not leave
 * the machine", not one that means "this is worth a look". A hook that opened
 * four windows and took seven minutes on every push would be removed within a
 * day, and a removed hook checks nothing. What the full level buys is written
 * onto a RECEIPT, and `tools/pre-push.sh` refuses a push whose commit has no
 * receipt -- so the minutes are owed before a push, not on every one.
 *
 * **What it deliberately does not decide.** Whether the product is good. It
 * runs what exists and says exactly what does not exist yet, by name, every
 * time. See `MISSING` below: a gate that quietly covered eight of nine things
 * would be worse than one that covered none, because its green would be
 * believed.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

/** Where a receipt is kept. Per-machine and untracked: it is about a run, not about the code. */
const RECEIPTS = join(REPO, '.gate');
const LATEST = join(RECEIPTS, 'receipt.json');
const HISTORY = join(RECEIPTS, 'receipts.ndjson');

/** What the stand leaves behind for this file to do arithmetic on. */
const VERDICT = join(REPO, '.vscode-test', 'stand-output', 'verdict.json');

/**
 * The stages, in the order a person wants them to fail in: cheapest first, so
 * that a typo is a six-second answer and not a seven-minute one.
 *
 * `fast` marks the stages the `pre-push` hook runs. Everything else runs only in
 * the full gate.
 */
const STAGES = [
  {
    name: 'types',
    fast: true,
    what: 'pnpm run typecheck',
    command: ['pnpm', 'run', 'typecheck'],
  },
  {
    name: 'lint',
    fast: true,
    what: 'pnpm run lint  (strictTypeChecked, --max-warnings 0)',
    command: ['pnpm', 'run', 'lint'],
  },
  {
    name: 'unit',
    fast: true,
    // With coverage, because the thresholds ARE the promise (65/80/80/80 global,
    // 100 on the pure rules) and `npx jest` on its own does not check them.
    // Measured 2026-08-25: 11.5 s without, 19.7 s with.
    what: 'npx jest --coverage  (the thresholds in jest.config.js)',
    command: ['npx', 'jest', '--coverage'],
  },
  {
    name: 'live',
    fast: false,
    what: 'pnpm run test:integration  (two labels in a downloaded VS Code; measured 4 min 20 s)',
    command: ['pnpm', 'run', 'test:integration'],
  },
  {
    name: 'stand',
    fast: false,
    what: 'pnpm run test:stand  (four windows on this desktop; measured 2 min 10 s), then gate/allowed-red.json',
    command: ['pnpm', 'run', 'test:stand'],
    // The stand's own exit code is not the answer. Two or three of its nine
    // points come back red on this revision -- two every time and a third that
    // comes and goes with the window -- and all three are admitted by name in
    // `gate/allowed-red.json` by the Ш6 orchestrator, which the owner has not
    // ratified. The budget decides, and it is stricter than the stand in the
    // directions that matter -- an unadmitted point, a point over its ceiling, a
    // point that has come back green and kept its permission, a line past its
    // date, and one line too many.
    verdictIsJudgedByTheBudget: true,
  },
];

/**
 * What this gate does NOT cover, printed on every run, green or red.
 *
 * Adding one of these is moving its entry into `STAGES`, which is the line this
 * list exists to make cheap. Until then the gate says so out loud rather than
 * letting a green be read as more than it is (I.1).
 */
const MISSING = [
  {
    name: 'cursor-strip',
    why:
      'Ш9 -- the live suites in Cursor, and the "the miss rate did not grow" rule over 3-5 repeats. ' +
      'HALF of Ш9 is already here and should not be claimed twice: the `stand` stage runs in Cursor ' +
      'when Cursor is installed (tests/stand/run.mjs prefers it, and the recording writes down which ' +
      'editor answered). What is missing is the LIVE suites, which run against a downloaded stable ' +
      'VS Code (.vscode-test.mjs, `version: stable`, both labels). ' +
      'To add it: give this a `command` and move the entry into STAGES with `fast: false`.',
  },
  {
    name: 'mutation',
    why:
      'Stryker. Measured 2026-08-24: its sandbox does not survive a pnpm workspace, and `--inPlace` ' +
      'edits 364 product files which a killed run leaves edited. Barred until it is a dependency with ' +
      'its own config AND refuses to start on a dirty tree, both checked rather than remembered.',
  },
  {
    name: 'acceptance',
    why:
      '`pnpm run test:acceptance` and `pnpm run test:vsix`. They start a real `claude` and spend real ' +
      'turns on the owner\'s account, so they are run by a person who meant to, not by a gate.',
  },
];

function say(line = '') {
  console.log(line);
}

/** One stage, run so that its own output reaches the terminal as it happens. */
function runStage(stage) {
  const started = Date.now();
  say('');
  say(`=== ${stage.name}  --  ${stage.what}`);
  const [command, ...args] = stage.command;
  const done = spawnSync(command, args, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  const ms = Date.now() - started;
  if (done.error !== undefined) {
    return { name: stage.name, ok: false, ms, because: `${stage.command.join(' ')} did not start: ${done.error.message}` };
  }
  return { name: stage.name, ok: done.status === 0, ms, status: done.status };
}

/**
 * The stand's verdict against the budget of admitted redness.
 *
 * The stand having exited non-zero is not by itself an answer here: it exits
 * non-zero for a point admitted in writing exactly as it does for one nobody
 * expected. What is not negotiable is that the verdict EXISTS -- a stand that
 * died before judging must never be read as a stand that judged nothing.
 */
function standAgainstTheBudget(ran) {
  try {
    return standAgainstTheBudgetOrThrow(ran);
  } catch (failed) {
    // A budget that cannot be read is the gate's own instructions being wrong,
    // and the gate says so in a sentence instead of a stack trace. It is red
    // either way; what changes is whether the person reading it knows which of
    // the two files to open.
    return { ...ran, ok: false, because: `gate/allowed-red.json could not be read: ${failed.message}` };
  }
}

function standAgainstTheBudgetOrThrow(ran) {
  const { ALLOWANCES, readAllowances, todayIs, verdictAgainstAllowances } =
    require(join(REPO, 'out', 'tests', 'stand', 'allowance.js'));

  if (!existsSync(VERDICT)) {
    return {
      ...ran,
      ok: false,
      because:
        `the stand left no verdict at ${VERDICT}, so there is nothing to hold the budget against. ` +
        'It died before it judged, and its own output above says where.',
    };
  }

  const verdict = JSON.parse(readFileSync(VERDICT, 'utf8'));
  const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));
  const today = todayIs(new Date());
  const refusals = verdictAgainstAllowances(verdict, document, today);

  say('');
  say(`--- the stand against gate/allowed-red.json, on ${today}`);
  for (const found of verdict.findings) {
    const admitted = document.allowances.some((one) => one.point === found.point);
    const mark = found.answer === 'green' ? 'green' : admitted ? 'red (admitted)' : 'red';
    say(`  ${String(found.point)}. ${mark.padEnd(15)}${found.says}`);
  }
  for (const refusal of refusals) {
    say(`  REFUSED  ${refusal.point === null ? 'the budget itself' : `point ${String(refusal.point)}`}: ${refusal.because}`);
  }
  if (refusals.length === 0) {
    say(`  every point that is not green is one of the ${String(document.allowances.length)} admitted, inside the number its line admits.`);
    say(`  the earliest of those lines stops working on ${document.allowances.map((one) => one.expires).sort()[0] ?? 'no date at all'}.`);
  }

  // Printed whatever colour this ends in, and printed here rather than left in
  // the file, because the thing most easily misread is a GREEN gate: green
  // means "red only where a line admits it", and a line nobody but its own
  // author has agreed to is not the same fact as one the owner signed. Naming
  // the admitter out loud is what keeps the two apart at the moment somebody
  // reads the colour (I.1).
  const unratified = document.allowances.filter((one) => one.ratifiedBy === null);
  if (unratified.length > 0) {
    say(
      `  NOT RATIFIED: point(s) ${unratified.map((one) => String(one.point)).join(', ')} stand on their admitter's ` +
      'own authority; nobody has ratified them and the owner has not agreed to them.'
    );
    for (const who of [...new Set(unratified.map((one) => one.allowedBy))]) {
      say(`    admitted by ${who}`);
    }
  }
  // The other half, and it is printed for the reason the first half is: until
  // 2026-08-25 `allowedBy` was said out loud here and `ratifiedBy` was not,
  // which made the quieter field the better place to forge. Both are read here
  // now, so a ratification is a thing somebody sees rather than a word in a
  // file nobody opens.
  for (const line of document.allowances.filter((one) => one.ratifiedBy !== null)) {
    say(`  RATIFIED: point ${String(line.point)} by ${line.ratifiedBy}`);
  }
  for (const line of document.allowances.filter((one) => one.renewals > 0)) {
    say(
      `  RENEWED: point ${String(line.point)} has had its date moved ${String(line.renewals)} time(s)` +
      `${line.ratifiedBy === null ? ', unratified -- one is all an unratified line gets' : ''}.`
    );
  }

  return {
    ...ran,
    ok: refusals.length === 0,
    because: refusals.length === 0 ? undefined : `${String(refusals.length)} refusal(s) from the budget`,
    budget: { today, refusals, admitted: document.allowances.map((one) => one.point) },
  };
}

/** The revision this run is about, and whether anything is uncommitted around it. */
function revision() {
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  try {
    return {
      head: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      dirty: git('status', '--porcelain').length > 0,
    };
  } catch (failed) {
    return { head: null, tree: null, dirty: null, because: failed.message };
  }
}

/**
 * The receipt: which revision was put through which level, and what came back.
 *
 * It is the only answer this repository has to "was what is being pushed ever
 * checked", and it is a weak one, said plainly: it is per-machine, untracked,
 * and written by the very run it vouches for. What it does buy is that
 * `tools/pre-push.sh` can refuse a commit nothing has ever run the full gate
 * over, instead of trusting that somebody remembers. `git push --no-verify`
 * walks past all of it and leaves nothing behind -- see the report of Ш6.
 */
function writeReceipt(receipt) {
  mkdirSync(RECEIPTS, { recursive: true });
  writeFileSync(LATEST, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(HISTORY, `${JSON.stringify(receipt)}\n`, { flag: 'a', encoding: 'utf8' });
}

function main() {
  const fast = process.argv.includes('--fast');
  const level = fast ? 'fast' : 'full';
  const at = revision();

  say(`the gate, ${level} level, over ${at.head === null ? 'a revision git would not name' : at.head.slice(0, 12)}${at.dirty === true ? ' + uncommitted changes' : ''}`);
  if (fast) {
    say('  --fast: types, lint and the unit suites. NOT the live suites and NOT the stand.');
    say('  This level is what `pre-push` runs. It is not what "checked" means -- run `pnpm run gate` for that.');
  }

  const wanted = STAGES.filter((stage) => !fast || stage.fast);
  const ran = [];
  for (const stage of wanted) {
    let result = runStage(stage);
    if (stage.verdictIsJudgedByTheBudget === true) {
      result = standAgainstTheBudget(result);
    }
    ran.push(result);
    if (!result.ok) {
      // Everything after a failure would be run against a tree already known to
      // be wrong, and ten minutes of it. Stop, and say which stage.
      break;
    }
  }

  const failed = ran.filter((one) => !one.ok);
  const skipped = wanted.slice(ran.length);

  say('');
  say('=== the gate');
  for (const one of ran) {
    say(`  ${one.ok ? 'PASS' : 'FAIL'}  ${one.name.padEnd(8)}${String(Math.round(one.ms / 1000)).padStart(5)} s${one.because === undefined ? '' : `   ${one.because}`}`);
  }
  for (const one of skipped) {
    say(`  ----  ${one.name.padEnd(8)}    -    not reached: an earlier stage failed`);
  }
  if (fast) {
    for (const one of STAGES.filter((stage) => !stage.fast)) {
      say(`  ----  ${one.name.padEnd(8)}    -    not in the fast level: ${one.what}`);
    }
  }

  say('');
  say('what this gate does NOT cover, whatever colour it just printed:');
  for (const one of MISSING) {
    say(`  * ${one.name}: ${one.why}`);
  }

  const receipt = {
    level,
    at: new Date().toISOString(),
    revision: at,
    ok: failed.length === 0,
    stages: ran.map(({ name, ok, ms, because, budget }) => ({ name, ok, ms, because, budget })),
    notCovered: MISSING.map((one) => one.name),
  };
  writeReceipt(receipt);

  say('');
  if (failed.length === 0) {
    say(level === 'full'
      ? 'GREEN. This is the only thing in this repository that may be called "checked".'
      : 'GREEN at the fast level. This is NOT "checked": the live suites and the stand did not run.');
  } else {
    say(`RED at ${failed.map((one) => one.name).join(', ')}.`);
  }
  say(`the receipt is at ${LATEST}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
