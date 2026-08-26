import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
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
 * other's. This paragraph used to say that neither trade had to be made because
 * the expensive option turned out not to exist -- Cursor's test host registering
 * no third-party extension at all -- and that is REFUTED. Measured 2026-08-25
 * over 33 launches: it is the fork's GLASS window that registers none (48
 * entries, ours absent, 5 launches of 5), and the same host outside glass
 * registers ours in 12 launches of 12 under `--classic`, at 113 entries. The
 * expensive option exists and costs what it always did. So the third level is
 * held off by its PRICE and by nothing else, which is a weaker reason than the
 * one that stood here, and it is left weaker on purpose (see the `cursor-live`
 * entry below). What runs in Cursor for 17 seconds instead is the fork's
 * workbench.
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

/**
 * Which tests a red stage says went red, read out of the output it prints anyway.
 *
 * Loaded here at the top rather than where it is used, and CommonJS rather than
 * a compiled module, because the FIRST stage this is asked about is `types` --
 * which is `tsc --build`, and a stage that has not run yet cannot have produced
 * the thing that reads it. See the head of `tools/what-fell.js`.
 */
const { transcript, whatFell } = require(join(REPO, 'tools', 'what-fell.js'));

/**
 * How much of a stage's output is held while it runs.
 *
 * A megabyte, which is far more than any stage here produces (the largest
 * measured is the live stage) and small enough that an extension host stuck in
 * a logging loop cannot make the gate itself the thing that falls over. What is
 * kept is the TAIL: Mocha, Jest and ESLint all say what failed at the END, so a
 * transcript that filled up and stopped listening would drop the one thing it
 * exists for.
 */
const MOST_KEPT = 1_000_000;

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
 * Not its exit code, and that is measured rather than assumed. The first
 * measurement, 2026-08-25, was a Cursor test host that printed `1 failing` and
 * exited 0 where VS Code 1.134.0 exited 1 on the same file. Thirty-three
 * launches later the same day, that turned out to be the mild reading of the
 * defect: the exit code FLICKERS. 5 launches out of 12 under `--classic` exited
 * 1, 1 of 4 under `--glass`, 0 of 6 with no flag, and four identical
 * consecutive launches gave 1, 0, 0, 1. A host that always exits 0 manufactures
 * green and can at least be worked around by a rule; a host that answers
 * differently to the same command can be neither trusted nor caught. So reading
 * the FILE is not a workaround here -- it is the only reading there is.
 */
const CURSOR_RATE = join(REPO, '.vscode-test', 'cursor-output', 'rate.json');

/** Where the eyes leave what they saw, for the same reason the Cursor strip does. */
const EYES_VERDICT = join(REPO, '.vscode-test', 'eyes-output', 'verdict.json');

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
 * The eyes, which are a LEVEL of their own and not a stage of the full gate.
 *
 * **Why they are not in the full run, decided rather than drifted into.** The
 * full gate is 7.7 to 9.3 minutes against a ceiling of ten, and one pass of the
 * eyes is another two: putting them in would put the gate over the ceiling, and
 * a gate nobody can afford to run is a gate nobody runs. The plan asked for
 * "a mark of its own whose failure does not stop the other gates", and a level
 * of its own is the strongest form of that -- not merely a stage that fails
 * quietly, but one that cannot delay or redden anything else, ever.
 *
 * The price, said plainly: nothing runs the eyes unless a person asks. That is
 * why they have an entry in `MISSING` as well, printed on every gate green or
 * red, rather than being remembered by whoever wrote them.
 *
 * `pnpm run gate:eyes` is `--only eyes`, and the receipt it leaves says
 * `only:eyes`, which `tools/gate-receipt.mjs` refuses as "checked".
 *
 * @returns {object[]} the eyes stage, or an empty list where there is no editor
 */
function theEyes() {
  const cursor = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe');
  const code = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (!existsSync(cursor) && !existsSync(code)) {
    return [];
  }
  return [
    {
      name: 'eyes',
      fast: false,
      // Kept out of the full and fast levels, and reachable only by name.
      onItsOwn: true,
      what: 'pnpm run test:eyes  (one window, looked at over the DevTools protocol; measured 2026-08-26: '
        + '52 s in VS Code 1.134.0, 102 s in Cursor 3.17.19)',
      command: ['pnpm', 'run', 'test:eyes'],
      before: () => { rmSync(dirname(EYES_VERDICT), { recursive: true, force: true }); },
      judgedBy: eyesAgainstWhatTheySaw,
    },
  ];
}

/**
 * What the eyes saw, which is the whole of this stage's colour.
 *
 * The exit code is not consulted, and for a reason this repository has already
 * paid for once: a driver that died before it looked also exits non-zero, and
 * "the button is missing" and "the window never came up" must never be the same
 * answer. The verdict file separates them -- REFUSED is what a look nobody got
 * comes to -- and a missing file is red on its own, because a run that died
 * before writing one is the single outcome an exit code cannot describe.
 */
function eyesAgainstWhatTheySaw(ran) {
  try {
    return eyesAgainstWhatTheySawOrThrow(ran);
  } catch (failed) {
    return { ...ran, ok: false, because: `the eyes could not be judged: ${failed.message}` };
  }
}

function eyesAgainstWhatTheySawOrThrow(ran) {
  if (!existsSync(EYES_VERDICT)) {
    return {
      ...ran,
      ok: false,
      because:
        `the eyes left no verdict at ${EYES_VERDICT}, so there is nothing to read. They died before they ` +
        'looked, and their own output above says where.',
    };
  }

  const verdict = JSON.parse(readFileSync(EYES_VERDICT, 'utf8'));
  const build = verdict.build;

  say('');
  say(
    `--- what the eyes saw, in ${build === null || build === undefined ? 'an editor whose build went unrecorded' : `${build.editor} ${build.version}`}` +
    `${build === null || build === undefined ? '' : ` (commit ${String(build.commit).slice(0, 8)}, built ${String(build.built).slice(0, 10)})`}`
  );
  for (const finding of verdict.findings) {
    say(`  ${String(finding.point)}. ${finding.answer.toUpperCase().padEnd(8)}${finding.scenario.padEnd(5)}${finding.says}`);
  }
  if (verdict.refused > 0) {
    // Printed apart from the reds and never counted with them: a refusal is the
    // eyes saying they did not get a look, and reading it as a clean bill of
    // health is the one way this stage could report more than it knows (I.1).
    say(
      `  ${String(verdict.refused)} sighting(s) REFUSED -- the eyes did not get a look at those parts of the ` +
      'window. That is not a green: nothing is known about them either way.'
    );
  }

  return {
    ...ran,
    ok: verdict.red === 0,
    because: verdict.red === 0 ? undefined : `${String(verdict.red)} sighting(s) red`,
    eyes: {
      build,
      green: verdict.green,
      red: verdict.red,
      refused: verdict.refused,
      findings: verdict.findings.map(({ point, scenario, answer }) => ({ point, scenario, answer })),
    },
  };
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
      'are not. WHAT IT USED TO SAY WAS REFUTED: until 2026-08-25 this record read "There is no ' +
      'configuration for this: it is what that host does", and that is withdrawn. It stood here through a ' +
      'day of green gates after the measurement that broke it. ' +
      'MEASURED 2026-08-25 over 33 launches of the two editors, driving `Cursor.exe` directly: the refusal ' +
      'to register a third-party extension belongs to the fork`s GLASS window and NOT to its test host. A ' +
      'glass window answers 48 entries in `vscode.extensions.all`, every one of them Cursor`s own, ours ' +
      'absent -- 5 launches out of 5. The same host in a window that is not glass answers 113 with ours ' +
      'among them: 12 launches out of 12 under `--classic`, 6 out of 6 with no flag but a folder to open, ' +
      '3 out of 3 under `--glass --classic`. So there IS a configuration for it. It is `--classic`, a ' +
      'documented flag of the fork`s own binary ("Disable glass mode and force classic windows"), and it ' +
      'beats an explicitly requested `--glass`. What is true of a glass window and was written here as ' +
      'true of the host: every suite under `tests/integration` opens by asserting ' +
      '`getExtension("gripterm-placeholder.gripterm")` is there, so in a GLASS window every one of them ' +
      'fails in its first hook. ' +
      'WHAT THAT LEAVES: the live suites in Cursor are UNRUN, not impossible. Between them and this gate ' +
      'stand a cost and a question, neither of them the fork`s doing -- 4 min 30 s onto a full gate ' +
      'measured at 7.7 to 9.3 against a ceiling of ten, and what the `cursor` stage should measure once ' +
      'its window can be chosen on purpose. The second is the owner`s to answer and was open on ' +
      '2026-08-25. ' +
      'SECOND, INDEPENDENT REASON, and this one got WORSE rather than better: the exit code of a Cursor ' +
      'test host FLICKERS. Measured the same day on one build with one probe: 5 launches out of 12 under ' +
      '`--classic` exited 1, 1 of 4 under `--glass`, 0 of 6 with no flag, and four identical consecutive ' +
      'launches gave 1, 0, 0, 1. VS Code 1.134.0 exited 1 in 5 out of 5. A flicker is worse than a stable ' +
      'falsehood: a host that always exits 0 can be worked around by a rule, and one that answers ' +
      'differently to the same command can be neither trusted nor caught. ' +
      'WHAT IS HERE INSTEAD, and it is not nothing: the `cursor` stage runs the fork`s WORKBENCH in ' +
      'Cursor -- the part that needs no extension of ours, and the part all four of the customer`s ' +
      'defects live in -- and the `stand` stage runs the PRODUCT in Cursor through a DEV host, where ' +
      'the extension does load. Between them, what is uncovered is narrower than "Cursor": it is the ' +
      'product`s behaviour under a Cursor test host, which nothing here has yet shown anybody. ' +
      'What would close it: paying those minutes with the stage`s window chosen by name -- not, as this ' +
      'entry used to say, a change in the fork.',
  },
  {
    name: 'eyes',
    why:
      'THE EYES -- `pnpm run gate:eyes`, which is `--only eyes`. They open a real editor, attach to its ' +
      'workbench over the DevTools protocol and ask the DOM what it is DRAWING: whether the maximise button ' +
      'is there and has a box, whether a terminal`s tab is coloured the way its own row is, and -- since ' +
      '2026-08-26 -- whether the notification a waiting agent raises is on the screen and where its button ' +
      'takes the person who presses it. They are a ' +
      'LEVEL of their own and this gate never runs them, on purpose: the full gate is 7.7-9.3 minutes ' +
      'against a ceiling of ten and one pass of the eyes is another two, so including them would put the ' +
      'gate over the ceiling -- and the plan asked for a mark whose failure does not stop the other gates. ' +
      'WHAT THAT COSTS: nothing runs them unless a person asks, so a button that stops being drawn between ' +
      'two people asking goes unnoticed for as long as that. WHAT THEY FOUND, measured 2026-08-25 with ' +
      'the terminal`s group 1006 px wide and a terminal in front: in Cursor 3.17.19 the ' +
      '`editor/title` maximise button was NOT DRAWN, beside four controls of Cursor`s own in the same bar ' +
      'that were; in VS Code 1.134.0 the same build drew it at 22x22. That is the defect the customer ' +
      'reported three times, and it is the first number anybody had for it. FIXED 2026-08-26 AND ' +
      'MEASURED THE SAME WAY, and the past tense above is deliberate: the fork hides, in `editor/title` ' +
      'and in no other menu, every command an EXTENSION contributes there unless its id starts with one ' +
      'of ten prefixes of its own (`PersistedMenuHideState.isHidden`, both of its workbenches, nought ' +
      'occurrences in VS Code). A submenu is not covered by that rule and a one-item submenu in the ' +
      '`navigation` group is folded back into its one icon, so the manifest goes that way now and the ' +
      'button draws at 22x22 in BOTH editors. The eyes also press it, twice, with a FILE in front: the ' +
      'strip went 381 px of a 1143 px editor area, then 1143 of 1143, then 381 again, the same three ' +
      'numbers in Cursor 3.17.19 and VS Code 1.134.0. ' +
      'WHETHER THE EYES WOULD CATCH S26 AT ALL -- ANSWERED 2026-08-26, AND UNANSWERED BEFORE THAT DAY: ' +
      'the tab-against-row sightings had never once come back red, in any run, so "they are green" said ' +
      'nothing about whether they could go red. A POSITIVE CONTROL was put under them and then removed. ' +
      'A stand-in extension registered a second `FileDecorationProvider` over ONE of the ' +
      '`vscode-terminal:` uris the product colours a tab through -- so the editor drew the disagreement, ' +
      'through the product`s own channel, with nothing of the eyes in the picture -- and in ONE run of ' +
      'VS Code 1.134.0 the two sightings read 2 green before it, then RED for the decorated tab ' +
      '(`rgb(173, 128, 215)` where `rgb(134, 207, 134)` was due) and GREEN for the other, in the same ' +
      'look. A second control was measured and rejected: the driver painting the tab itself reddens ' +
      'identically, but a driver that writes into the DOM it reads cannot tell "the eyes see the colour" ' +
      'from "the eyes see what they wrote". WHAT IS STILL NOT PROVEN: that a LATER build would be ' +
      'caught, because nothing repeats the control -- it is a fact about that day and that build, and ' +
      'the head of `tests/eyes/run.mjs` says so. ' +
      'S25, MEASURED END TO END FOR THE FIRST TIME 2026-08-26, both halves: the observer posts the CLI`s ' +
      'own `PermissionRequest` hook to the product`s own loopback endpoint (the token and session id come ' +
      'from that terminal`s `creationOptions`), and in VS Code 1.134.0 the product raised the toast ' +
      '"eyes-project 2 is waiting for permission" at 452x86, and pressing its "Show terminal" button ' +
      'closed it and put THAT terminal in front -- the tab the eyes saw and `window.activeTerminal` ' +
      'agreeing. What the AGENT does is the only thing stood in for. ' +
      'IN CURSOR 3.17.19 THE SAME REQUEST SHOWED NO TOAST THE EYES COULD FIND, AND THAT IS RECORDED AS ' +
      'REFUSED RATHER THAN AS A DEFECT, on purpose and after it was nearly recorded as one. The first ' +
      'anchor for this sighting was the editor`s own notification bell, which is drawn whether or not ' +
      'anything was raised -- and against it the fork answered "NOT DRAWN, beside Notifications, which ' +
      'the editor drew", a red about the product resting on nothing. A bell in the status bar proves the ' +
      'STATUS BAR was seen. So the observer now raises a notification OF ITS OWN a moment after the ' +
      'product`s, through the same one API, and in Cursor the eyes did not find THAT one either: the ' +
      'sighting refuses, and what is unknown there is whether the fork toasts an extension`s ' +
      'notification at all or merely toasts it somewhere these selectors do not look. Its bell reads ' +
      '`codicon-bell-dot`, so something was raised. WHAT WOULD CLOSE IT: reading that fork`s ' +
      'notification DOM, which nobody has done. ' +
      'FOUR RUNS WERE SPENT ON THE PRESS FIRST, and both reasons are worth keeping because both ' +
      'looked exactly like a button that does nothing. One: a press dispatched over the DevTools ' +
      'protocol carries the window`s REAL pixels, while the eyes lay the workbench out at 1920x1200 over ' +
      'a window the desktop had made 1440x900, so every press landed outside it -- ours AND the editor`s ' +
      'own control on the same toast, which is how the eyes knew to answer REFUSED instead of accusing ' +
      'the product. The override is lifted around the press now. Two: the FIRST press this driver sends ' +
      'into a window is spent and the second answers, with `Page.bringToFront` before it and without, so ' +
      'the eyes press once more and print how many presses it took. What keeps the difference honest is ' +
      'a control on the press itself: when ours changes nothing, the EDITOR`S OWN control on the same ' +
      'toast is pressed the same way, and a toast that answers neither is a run that says REFUSED. ' +
      'WHAT THE EYES CANNOT SEE IN CURSOR, AND IT IS NOT OUR SIDE: on a fresh profile the fork lays out ' +
      'no side bar and no panel and has no activity bar in the DOM at all -- measured 2026-08-26 at ' +
      '1920x1200: `.part.activitybar` absent, `.part.sidebar` `display: none` 0x0, `.part.panel` ' +
      '`display: none` 0x0, against `.part.auxiliarybar` (the fork`s own chat) 400x1143 and ' +
      '`.part.editor` 1006x1143. Four commands of the EDITOR`S OWN were executed in that window to try ' +
      'to open it -- `workbench.action.toggleSidebarVisibility`, `workbench.action.focusSideBar`, ' +
      '`workbench.view.explorer`, `gripterm.terminals.focus`, none of them refused -- and the side bar ' +
      'stayed `display: none`. So the list of terminals cannot be looked at in that fork by these or any ' +
      'other eyes, and no other anchor for it was found: the rows are in the DOM with the right icons ' +
      'and nobody can see them, which is a picture the judge must refuse rather than read. In Cursor ' +
      'that leaves S13`s view-title sighting and both S26 sightings REFUSED, and only what lives in the ' +
      'editor area answered.',
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

/**
 * A stage's own output, on the terminal as it happens AND kept for reading.
 *
 * **Piped rather than inherited, and that is a trade with a named price.** The
 * stage used to be launched with `stdio: 'inherit'`, which is the cheapest way
 * to put a child's output on a terminal and the one way to make sure nothing
 * else can ever see it. Every chunk is now written on as it arrives, so the
 * four minutes of the live stage still scroll past in real time; what changes is
 * that a tool asking `process.stdout.isTTY` is now answered "no", and the ones
 * that colour their output by that answer stop colouring it. Measured
 * 2026-08-26: Jest colours its code frames regardless, so `tools/what-fell.js`
 * strips ANSI either way; `tsc` and ESLint go plain. That is the whole cost, it
 * is cosmetic, and it buys the receipt a name for what fell over.
 *
 * Nothing in this repository reads its own stdout as a terminal -- checked
 * 2026-08-26 across `tools`, `tests` and every package's `src`: the only
 * `isTTY` and `process.stdout.columns` in the tree are inside processes the
 * suites spawn under a pty, which is a different stdout entirely.
 */
function theOutputOf(command, args, kept) {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      cwd: REPO,
      // stdin stays inherited: nothing here asks a question, and a child given a
      // closed stdin behaves differently from one given a terminal's.
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { process.stdout.write(text); kept.say(text); });
    child.stderr.on('data', (text) => { process.stderr.write(text); kept.say(text); });
    child.on('error', (failed) => { settle({ status: null, error: failed }); });
    // `close` and not `exit`: the last of a stage's output arrives after the
    // process is gone, and that last part is where Mocha prints what failed.
    child.on('close', (status) => { settle({ status, error: null }); });
  });
}

/**
 * What a red stage's output says fell over, in the few strings a receipt holds.
 *
 * A stage the parser does not recognise is written down as `unrecognised`
 * rather than left out: "the gate looked and could name nothing" and "nobody
 * looked" are different facts, and the first one is the entry that says a
 * format wants teaching (I.1).
 */
function whatItSaidFellOver(kept) {
  const fell = whatFell(kept.said()) ?? { kind: 'unrecognised', count: null, named: [], first: null };
  const dropped = kept.dropped();
  return dropped === 0 ? fell : { ...fell, dropped };
}

/** One stage, run so that its own output reaches the terminal as it happens. */
async function runStage(stage) {
  const started = Date.now();
  say('');
  say(`=== ${stage.name}  --  ${stage.what}`);
  if (stage.before !== undefined) {
    stage.before();
  }
  const [command, ...args] = stage.command;
  const kept = transcript(MOST_KEPT);
  const done = await theOutputOf(command, args, kept);
  const ms = Date.now() - started;
  if (done.error !== null) {
    return { name: stage.name, ok: false, ms, because: `${stage.command.join(' ')} did not start: ${done.error.message}` };
  }
  const ok = done.status === 0;
  // Only where the command itself came back non-zero. A stand judged red on a
  // clean exit has its answer in `budget` already, and a second answer read out
  // of prose would be the weaker of the two standing beside the stronger.
  return { name: stage.name, ok, ms, status: done.status, ...(ok ? {} : { fell: whatItSaidFellOver(kept) }) };
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
  const { ALLOWANCES, readAllowances, refusalForTheStart, todayIs, verdictAgainstAllowances } =
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
  /*
   * Two budgets, and the second one is admitted by nothing (Ш11).
   *
   * `gate/allowed-red.json` is how much of the stand's NINE POINTS a gate lets
   * through. The budget of the START is a ceiling on time, set from measurement
   * (`tests/stand/start-budget.ts`), and there is no line to write for it and no
   * cap to spend: a run over it is red here. A verdict that says nothing about
   * the start is refused too -- the stand writes it, so its absence is a stand
   * that never asked.
   */
  const startRefusal = refusalForTheStart(verdict.start);
  const refusals = [
    ...verdictAgainstAllowances(verdict, document, today),
    ...(startRefusal === null ? [] : [startRefusal]),
  ];

  say('');
  say(`--- the stand against gate/allowed-red.json, on ${today}`);
  for (const found of verdict.findings) {
    const admitted = document.allowances.some((one) => one.point === found.point);
    const mark = found.answer === 'green' ? 'green' : admitted ? 'red (admitted)' : 'red';
    say(`  ${String(found.point)}. ${mark.padEnd(15)}${found.says}`);
  }
  say(
    `  START. ${(verdict.start === undefined ? 'not judged' : verdict.start.answer).padEnd(15)}` +
      'the start of a window stayed inside the budget measured for it'
  );
  if (verdict.start !== undefined) {
    say(`     ${verdict.start.because}`);
  }
  for (const refusal of refusals) {
    say(`  REFUSED  ${refusal.point === null ? 'the budget itself' : `point ${String(refusal.point)}`}: ${refusal.because}`);
  }
  if (refusals.length === 0) {
    say(`  every point that is not green is one of the ${String(document.allowances.length)} admitted, inside the number its line admits.`);
    say('  the start of a window is inside the budget measured for it, which nothing admits and nothing may.');
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
 * What the Cursor strip measured, against the ceilings in the budget -- and in
 * WHICH of the fork's two workbenches it measured it.
 *
 * The whole of this stage's colour, because there is nothing else to read: the
 * exit code of the host it ran in is a coin (measured 2026-08-25, four identical
 * consecutive launches: 1, 0, 0, 1). A file that is not there is therefore RED
 * and is never silence -- a probe that died before writing is the one outcome a
 * clean pass is indistinguishable from once the exit code says nothing.
 *
 * **Three answers since 2026-08-26, not two.** Cursor opens a window in one of
 * two workbenches and names neither through its API; the same command misses 10
 * of 10 in the glass one and none of 10 outside it. So a rate whose workbench is
 * not established is UNMEASURED -- red, and never "so many misses of so many",
 * because the second sentence sends a person after a defect of the product on a
 * day the window changed. The rule lives in `cursorAgainstBudget` where a Jest
 * suite can hold it; this prints it.
 */
function cursorAgainstTheBudget(ran) {
  try {
    return cursorAgainstTheBudgetOrThrow(ran);
  } catch (failed) {
    return { ...ran, ok: false, because: `the Cursor strip could not be judged: ${failed.message}` };
  }
}

function cursorAgainstTheBudgetOrThrow(ran) {
  const { ALLOWANCES, cursorAgainstBudget, readAllowances } =
    require(join(REPO, 'out', 'tests', 'stand', 'allowance.js'));

  if (!existsSync(CURSOR_RATE)) {
    return {
      ...ran,
      ok: false,
      because:
        `the Cursor strip left no numbers at ${CURSOR_RATE}, so there is nothing to hold the budget against. ` +
        'It died before it measured, and its own output above says where -- its exit code cannot tell you, ' +
        'because that host answers 1 or 0 to the same command (measured 2026-08-25: 1, 0, 0, 1 over four ' +
        'identical launches).',
    };
  }

  const measured = JSON.parse(readFileSync(CURSOR_RATE, 'utf8'));
  const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));
  const checks = measured.checks.map((one) => ({ check: one.check, attempts: one.attempts, misses: one.misses }));
  // The workbench BEFORE the arithmetic, and the arithmetic only if it holds.
  // Cursor has two workbenches whose answers to the same command differ
  // completely -- 10 misses of 10 against none of 10 -- and which one this stage
  // opens is decided by an argument that is here for something else. So a run
  // that cannot say which one it measured has numbers with nowhere to be filed,
  // and this prints the reason instead of a rate. See `cursorAgainstBudget`.
  const workbench = measured.workbench ?? null;
  const judged = cursorAgainstBudget(checks, workbench, document);
  const refusals = judged.refusals;

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
  say(
    `  the workbench it measured: ${workbench === null ? 'NOT RECORDED -- this run said nothing about one' : `${workbench.is} -- ${workbench.because}`}`
  );
  if (judged.measured) {
    for (const one of measured.checks) {
      const line = document.rates.find((rate) => rate.check === one.check);
      say(
        `  ${one.check}: ${String(one.misses)} miss(es) of ${String(one.attempts)}` +
        `${line === undefined ? '   -- nothing in the budget names this check' : `, and its line admits ${String(line.atMost)} of ${String(line.of)}`}`
      );
    }
  } else {
    // The numbers deliberately go unprinted. They exist -- they are in the file
    // named below -- and printing them beside a budget they cannot be held
    // against is how "this run opened the other window" is read as "the product
    // missed 10 of 10".
    say(
      `  NOT JUDGED: the ${String(measured.checks.length)} check(s) this run wrote down are in ${CURSOR_RATE}, ` +
      'and no ceiling here applies to them.'
    );
  }
  for (const refusal of refusals) {
    say(`  ${judged.measured ? 'REFUSED ' : 'UNMEASURED'}  ${refusal.because}`);
  }
  for (const line of measured.notMeasured ?? []) {
    say(`  NOT MEASURED HERE: ${line}`);
  }

  return {
    ...ran,
    // The exit code is not consulted at all, and that is the point. `ran.ok`
    // said 0 and would have said 0 over ten failed assertions.
    ok: refusals.length === 0,
    because:
      refusals.length === 0
        ? undefined
        : judged.measured
          ? `${String(refusals.length)} refusal(s) from the budget`
          // Which workbench it was, and not "it could not say": a run that named
          // the WRONG one said plenty, and the two are told apart here because
          // telling them apart is the whole of this stage's third answer.
          : `the Cursor strip's numbers were not judged -- its workbench is ${workbench === null ? 'not recorded at all' : `"${workbench.is}"`}`,
    // The workbench goes onto the RECEIPT and not only into the printed
    // summary: a receipt is what `tools/pre-push.sh` reads and what an analysis
    // of a red gate re-reads weeks later, and a rate on it with no window
    // beside it is the record this step exists to stop being written.
    rates: { checks, refusals, build, workbench, judged: judged.measured },
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
  // The eyes go last and are excluded from every level but their own; they are
  // here at all so that `--only eyes` can find them by name.
  return [...STAGES.slice(0, at), ...inCursor(), ...STAGES.slice(at), ...theEyes()];
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

async function main() {
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
    // `onItsOwn` marks a stage that is a LEVEL rather than part of one: it runs
    // when it is asked for by name and never as part of the full gate. See
    // `theEyes()` for why that is a decision and not an oversight.
    ? here.filter((stage) => stage.onItsOwn !== true && (!fast || stage.fast))
    : here.filter((stage) => stage.name === only);
  const ran = [];
  for (const stage of wanted) {
    let result = await runStage(stage);
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
    // The same thing the receipt gets, said here as well, because the output it
    // was read out of is by now several thousand lines up the terminal.
    if (one.fell !== undefined) {
      say(`        ${one.fell.count === null ? 'an unknown number of things' : `${String(one.fell.count)} of them`} (${one.fell.kind}): ${one.fell.named.length === 0 ? 'nothing this gate knows how to name' : one.fell.named.join(' | ')}`);
      if (one.fell.first !== null) {
        say(`        first: ${one.fell.first}`);
      }
    }
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
    // `fell` is present only on a stage whose command came back non-zero, and
    // `JSON.stringify` drops the key everywhere else -- so a green stage's line
    // is byte-for-byte what it was before this field existed, and the 98 lines
    // already in `receipts.ndjson` are read by exactly what read them before
    // (`tools/gate-receipt.mjs`, which asks for `level`, `ok` and `revision`).
    stages: ran.map(({ name, ok, ms, because, budget, rates, eyes, fell }) => ({ name, ok, ms, because, budget, rates, eyes, fell })),
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

// Top-level await, because a stage is awaited now: see `theOutputOf`.
await main();
