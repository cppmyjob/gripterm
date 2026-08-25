import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * anyone's desktop. The full gate adds the live suites in a real editor, the
 * fork's workbench in Cursor, and the two-sitting stand, which opens four
 * windows; measured 7 min 30 s end to end before the Cursor stage and 17 s more
 * with it.
 *
 * **Why there is no THIRD level, which is what Ш9 was expected to need.** The
 * step was written expecting the live suites to run a second time in Cursor --
 * another 4 min 30 s onto a gate already at 7 to 9 minutes against a ten-minute
 * ceiling, which would have forced a `gate:full` nobody would run, or Cursor
 * INSTEAD of VS Code, which would have traded one editor's coverage for the
 * other's. Neither trade had to be made, because the expensive option turned out
 * not to exist: measured 2026-08-25, Cursor's extension test host registers no
 * third-party extension at all, so the live suites cannot run there however long
 * anybody is willing to wait (see the `cursor-live` entry below). What CAN run
 * in Cursor is the fork's workbench, and that costs 17 seconds. A level invented
 * for a cost that is not there would be a level whose only effect is to give
 * people a shorter gate to run instead of this one.
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
 * What the Cursor strip leaves behind, and the ONLY thing that stage's colour
 * may be read from.
 *
 * Not its exit code, and that is measured rather than assumed: on 2026-08-25 a
 * Cursor test host running a deliberately failing mocha file printed `1 failing`
 * and exited 0, where VS Code 1.134.0 exited 1 on the same file. A stage whose
 * exit code is always 0 is worse than no stage -- it manufactures green.
 */
const CURSOR_RATE = join(REPO, '.vscode-test', 'cursor-output', 'rate.json');

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
    judgedBy: standAgainstTheBudget,
  },
];

/**
 * The stages inserted only where the editor they need is on this machine.
 *
 * Cursor is not downloaded and cannot be: `@vscode/test-electron` fetches
 * builds of VS Code, and the fork the customer works in has no such feed. So
 * this stage exists on a machine with Cursor and does not exist on one without
 * -- and `MISSING` says so out loud in the second case, rather than a green gate
 * quietly meaning less than it did yesterday.
 *
 * @returns {object[]} the Cursor stage, or an empty list
 */
function inCursor() {
  const cursor = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe');
  if (!existsSync(cursor)) {
    return [];
  }
  return [
    {
      name: 'cursor',
      fast: false,
      what: 'pnpm run test:cursor  (the fork`s workbench, in the Cursor installed here; measured 17 s end to end)',
      command: ['pnpm', 'run', 'test:cursor'],
      // Yesterday's numbers must not be readable as today's, and this stage has
      // no exit code to fall back on if they were. The stand does the same in
      // its own `prepare()`; here it is the gate's job, because the config that
      // composes the run is loaded by the VS Code labels too and clearing a
      // Cursor verdict on the way into a VS Code run is how a verdict goes
      // missing between being written and being read.
      before: () => { rmSync(dirname(CURSOR_RATE), { recursive: true, force: true }); },
      judgedBy: cursorAgainstTheBudget,
    },
  ];
}

/**
 * What this gate does NOT cover, printed on every run, green or red.
 *
 * Adding one of these is moving its entry into `STAGES`, which is the line this
 * list exists to make cheap. Until then the gate says so out loud rather than
 * letting a green be read as more than it is (I.1).
 */
const MISSING = [
  {
    name: 'cursor-live',
    why:
      'The LIVE SUITES in Cursor, and this entry names WHY they are not here rather than only that they ' +
      'are not. MEASURED 2026-08-25, three launches, two launchers (@vscode/test-cli and a bare spawn), ' +
      'polling thirty seconds each: Cursor`s extension TEST host -- any window carrying ' +
      '`--extensionTestsPath` -- registers NO third-party extension at all. Not one loaded from ' +
      '`--extensionDevelopmentPath`, not one installed into `--extensions-dir`. ' +
      '`vscode.extensions.all` answers 48 entries, every one of them Cursor`s own; the same arguments ' +
      'against VS Code 1.134.0 answer 100, ours among them, at once. Every suite under ' +
      '`tests/integration` opens by asserting `getExtension("gripterm-placeholder.gripterm")` is there, ' +
      'so in Cursor every one of them fails in its first hook. There is no configuration for this: it ' +
      'is what that host does. SECOND, INDEPENDENT REASON: the same host exits 0 on a failing run ' +
      '(measured on a deliberately failing file; VS Code exited 1 on it), so even a suite that could ' +
      'run there could not be believed by an exit code. ' +
      'WHAT IS HERE INSTEAD, and it is not nothing: the `cursor` stage runs the fork`s WORKBENCH in ' +
      'Cursor -- the part that needs no extension of ours, and the part all four of the customer`s ' +
      'defects live in -- and the `stand` stage runs the PRODUCT in Cursor through a DEV host, where ' +
      'the extension does load. Between them, what is uncovered is narrower than "Cursor": it is the ' +
      'product`s behaviour under a Cursor test host, which no Cursor test host can show anybody. ' +
      'What would close it: the fork loading development extensions in that host, or a driver of our ' +
      'own in a dev host with an observer extension, as `tests/stand/run.mjs` does -- at the price of ' +
      'reimplementing mocha`s reporting and the window discipline the stand already carries.',
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
  if (stage.before !== undefined) {
    stage.before();
  }
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

/**
 * What the Cursor strip measured, against the ceilings in the budget.
 *
 * The whole of this stage's colour, because there is nothing else to read: the
 * host it ran in exits 0 whatever happened inside it. A file that is not there
 * is therefore RED and is never silence -- a probe that died before writing is
 * the one outcome an exit code of 0 and a clean pass look identical from.
 */
function cursorAgainstTheBudget(ran) {
  try {
    return cursorAgainstTheBudgetOrThrow(ran);
  } catch (failed) {
    return { ...ran, ok: false, because: `the Cursor strip could not be judged: ${failed.message}` };
  }
}

function cursorAgainstTheBudgetOrThrow(ran) {
  const { ALLOWANCES, ratesAgainstBudget, readAllowances } =
    require(join(REPO, 'out', 'tests', 'stand', 'allowance.js'));

  if (!existsSync(CURSOR_RATE)) {
    return {
      ...ran,
      ok: false,
      because:
        `the Cursor strip left no numbers at ${CURSOR_RATE}, so there is nothing to hold the budget against. ` +
        'It died before it measured, and its own output above says where -- its exit code cannot tell you, ' +
        'because that host exits 0 either way.',
    };
  }

  const measured = JSON.parse(readFileSync(CURSOR_RATE, 'utf8'));
  const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));
  const checks = measured.checks.map((one) => ({ check: one.check, attempts: one.attempts, misses: one.misses }));
  const refusals = ratesAgainstBudget(checks, document);

  say('');
  // The build, printed rather than left in the file, because it is the point of
  // recording it: a workbench measurement belongs to a build, a fork ships every
  // few days, and `vscode.version` inside that window answers the VS Code it is
  // a fork OF and not the build that was measured.
  const build = measured.build;
  say(
    `--- the Cursor strip, in ${build === null ? 'an editor whose build went unrecorded' : `${build.editor} ${build.version}`}` +
    `${build === null ? '' : ` (commit ${String(build.commit).slice(0, 8)}, built ${String(build.built).slice(0, 10)}, API ${measured.apiVersion})`}`
  );
  for (const one of measured.checks) {
    const line = document.rates.find((rate) => rate.check === one.check);
    say(
      `  ${one.check}: ${String(one.misses)} miss(es) of ${String(one.attempts)}` +
      `${line === undefined ? '   -- nothing in the budget names this check' : `, and its line admits ${String(line.atMost)} of ${String(line.of)}`}`
    );
  }
  for (const refusal of refusals) {
    say(`  REFUSED  ${refusal.because}`);
  }
  for (const line of measured.notMeasured ?? []) {
    say(`  NOT MEASURED HERE: ${line}`);
  }

  return {
    ...ran,
    // The exit code is not consulted at all, and that is the point. `ran.ok`
    // said 0 and would have said 0 over ten failed assertions.
    ok: refusals.length === 0,
    because: refusals.length === 0 ? undefined : `${String(refusals.length)} refusal(s) from the budget`,
    rates: { checks, refusals, build },
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

/**
 * The stages this machine can run, in the order a person wants them to fail in.
 *
 * By name rather than by index: the Cursor stage goes in front of the two that
 * open windows and take minutes, so that a fork that has moved under us is a
 * thirty-second answer and not a seven-minute one.
 *
 * @returns {object[]} every stage, the machine-dependent ones included
 */
function stagesHere() {
  const at = STAGES.findIndex((stage) => stage.name === 'live');
  return [...STAGES.slice(0, at), ...inCursor(), ...STAGES.slice(at)];
}

/**
 * What this gate does NOT cover on THIS machine, which is not always the same
 * list.
 *
 * A machine with no Cursor loses a stage, and a gate that lost a stage in
 * silence would print the same green as one that ran it. So the absence is an
 * entry, printed beside the permanent ones.
 *
 * @returns {{name: string, why: string}[]} the entries, in the order printed
 */
function notCovered() {
  const cursorless = inCursor().length === 0
    ? [{
      name: 'cursor',
      why:
        'There is no Cursor on this machine, so the `cursor` stage does not exist in this run at all -- and ' +
        'neither does the stand`s preference for it (tests/stand/run.mjs falls back to VS Code). Every one of ' +
        'the customer`s four defects was reported in Cursor. A green gate here is a green gate about the OTHER ' +
        'editor.',
    }]
    : [];
  return [...cursorless, ...MISSING];
}

/**
 * One named stage, for the person who has just made it go red.
 *
 * **It is not a level, and it is written so that it cannot become one.** The
 * receipt it leaves says `only:<name>`, and `tools/gate-receipt.mjs` accepts
 * nothing but `full`, so a stage run alone can never stand in for a checked
 * revision -- the one thing this whole file exists to keep honest.
 *
 * What it buys is that a red stand or a red Cursor strip can be re-run in its
 * own two minutes instead of behind the eight it takes to reach it again. The
 * alternative, which the person will otherwise do, is to run the underlying
 * `pnpm run test:...` by hand -- and that skips the BUDGET, which is the half of
 * those two stages that decides the colour.
 *
 * @param {string[]} argv the command line
 * @returns {string | null} the stage named, or null
 */
function onlyStage(argv) {
  const at = argv.indexOf('--only');
  return at === -1 ? null : argv[at + 1] ?? null;
}

function main() {
  const fast = process.argv.includes('--fast');
  const only = onlyStage(process.argv);
  const level = only === null ? (fast ? 'fast' : 'full') : `only:${only}`;
  const at = revision();

  say(`the gate, ${level} level, over ${at.head === null ? 'a revision git would not name' : at.head.slice(0, 12)}${at.dirty === true ? ' + uncommitted changes' : ''}`);
  if (fast) {
    say('  --fast: types, lint and the unit suites. NOT the live suites and NOT the stand.');
    say('  This level is what `pre-push` runs. It is not what "checked" means -- run `pnpm run gate` for that.');
  }
  if (only !== null) {
    say(`  --only ${only}: ONE stage and its budget, for re-running something that just went red.`);
    say('  The receipt this leaves says so, and `tools/gate-receipt.mjs` accepts none but a full one.');
  }

  const here = stagesHere();
  if (only !== null && !here.some((stage) => stage.name === only)) {
    say('');
    say(`there is no stage called ${JSON.stringify(only)} on this machine. There is: ${here.map((stage) => stage.name).join(', ')}.`);
    process.exitCode = 2;
    return;
  }
  const wanted = only === null
    ? here.filter((stage) => !fast || stage.fast)
    : here.filter((stage) => stage.name === only);
  const ran = [];
  for (const stage of wanted) {
    let result = runStage(stage);
    if (stage.judgedBy !== undefined) {
      result = stage.judgedBy(result);
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
  if (fast || only !== null) {
    for (const one of here.filter((stage) => !wanted.includes(stage))) {
      say(`  ----  ${one.name.padEnd(8)}    -    not in this level: ${one.what}`);
    }
  }

  const uncovered = notCovered();
  say('');
  say('what this gate does NOT cover, whatever colour it just printed:');
  for (const one of uncovered) {
    say(`  * ${one.name}: ${one.why}`);
  }

  const receipt = {
    level,
    at: new Date().toISOString(),
    revision: at,
    ok: failed.length === 0,
    stages: ran.map(({ name, ok, ms, because, budget, rates }) => ({ name, ok, ms, because, budget, rates })),
    notCovered: uncovered.map((one) => one.name),
  };
  writeReceipt(receipt);

  say('');
  if (failed.length === 0) {
    say(level === 'full'
      ? 'GREEN. This is the only thing in this repository that may be called "checked".'
      : `GREEN at the ${level} level. This is NOT "checked": ${skipped.length + (here.length - wanted.length)} stage(s) did not run.`);
  } else {
    say(`RED at ${failed.map((one) => one.name).join(', ')}.`);
  }
  say(`the receipt is at ${LATEST}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
