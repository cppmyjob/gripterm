/*
 * The measuring half of the two-sitting stand: it looks, it writes down, and it
 * judges nothing at all. `tests/stand/judge.ts` is the half that judges, and it
 * never starts an editor. The two meet at the format in `tests/stand/recording.ts`.
 *
 * Loaded beside the product into a REAL development host -- `--extensionDevelopmentPath`,
 * and deliberately NOT `--extensionTestsPath`: any run with that is
 * `ExtensionMode.Test`, and a test host was measured on 2026-08-21 to start with
 * one empty group whatever the sitting before it left behind. A question about
 * what a RESTART does cannot be asked there at all.
 *
 * Plain CommonJS on purpose: an extension the editor loads from source, with no
 * build step between what is written here and what runs, and nothing to keep in
 * step with the product's own compilation.
 *
 * **The earliest sighting is the whole point of the first ten lines.** The
 * activation order of two extensions in one host is not guaranteed, so this does
 * not "look first": it subscribes on its own first statement, keeps every
 * sighting, and records whether the product had ALREADY activated when it got
 * there. `judge.ts` turns that last flag into a red -- a clean picture taken
 * after somebody tidied is not evidence, and calling it one is how a stand goes
 * green on nothing.
 */

const vscode = require('vscode');
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

/** The product, by its exact identity: `/gripterm/i` would also match this file. */
const PRODUCT = 'gripterm-placeholder.gripterm';

const LOG = process.env.GRIPTERM_STAND_LOG;
const SITTING = Number(process.env.GRIPTERM_STAND_SITTING ?? '0');
const DONE = process.env.GRIPTERM_STAND_DONE;
const PROJECT = process.env.GRIPTERM_STAND_PROJECT;
/** How many terminals sitting one is to make. Nought in every sitting after it. */
const MAKE = Number(process.env.GRIPTERM_STAND_MAKE ?? '0');
/** Whether this sitting is to open a file over the strip when it has settled. */
const OPEN_A_FILE = process.env.GRIPTERM_STAND_OPEN_A_FILE === 'yes';

/** The three sightings `judge.ts` reads by name. Spelled once, in `recording.ts` too. */
const ACTIVATED = 'activated';
const SETTLED = 'settled';
const FILE_OPENED = 'a file opened';

/**
 * How long the window has to go quiet before it counts as settled, and how long
 * this waits for that in total.
 *
 * Quiet is measured from the last tab or group EVENT and not from a start, which
 * is the difference between waiting for something and betting on a number. The
 * ceiling exists because "no events" is also what a window that never woke up
 * looks like: without it a broken sitting hangs instead of going red.
 */
const QUIET_MS = 3000;
const SETTLES_WITHIN_MS = 90_000;

/** How long one asked-for terminal has to appear before the sitting gives up on it. */
const TERMINAL_WITHIN_MS = 60_000;

/** How often the clock is looked at while waiting for quiet. Not a wait of its own. */
const TICK_MS = 200;

/** How many times a torn pair of readings is taken again before it is written down as torn. */
const UNTORN_ATTEMPTS = 3;

/**
 * Putting the editor on one group by its number. The workbench spells this as
 * eight commands rather than one that takes an argument, which is why they are
 * listed; a ninth column cannot be focused by any command.
 */
const FOCUS_GROUP = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

/** Every sighting this sitting took, in order. `restoredMs` is read back out of it. */
const history = [];

let activatedAt = Date.now();
let lastChangeAt = Date.now();
let workspaceStorage = null;
let productAlreadyActive = null;
let writing = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Anything that goes into a line of the recording, with the machine it was taken
 * on left out of it.
 *
 * A recording gets committed, pasted into a report and sent to somebody, and
 * three of the strings in it are not this file's own words: what the editor
 * refused a grid with, what a command threw, and what a tab is labelled. All
 * three can hold an absolute path -- `vscode.open` names the file it could not
 * open, and names it as a `file:` URI with the drive percent-encoded and the
 * home directory spelled out in full -- and a path on a personal desktop names
 * the person. The last segment is kept because that is the half that says what
 * the message is ABOUT; the half taken away is the half that says whose machine
 * it happened on.
 *
 * The runner outside does the same thing to the one path IT writes down, by
 * recording `basename(editor)` rather than where the .exe was installed.
 * `tests/stand/no-machine-in-the-record.test.ts` is what holds both to it,
 * over the files rather than over the promise.
 */
function neutral(said) {
  const lastSegment = (path) => {
    const segments = path.split(/[\\/]/u).filter((one) => one.length > 0);
    const last = segments[segments.length - 1];
    return last === undefined ? '<path>' : `<path>/${last}`;
  };
  return String(said)
    // A drive-absolute path, with the drive spelled either way: `<drive>` and a
    // colon, or `<drive>` and the `%3A` a URI percent-encodes that colon into.
    // Written with a placeholder rather than with a letter on purpose -- a real
    // one here would be a path in a file whose own suite refuses paths.
    .replace(/(?:file:\/\/\/)?[A-Za-z](?::|%3[Aa])[\\/][^\s"'`()[\]<>]*/gu, lastSegment)
    // And a home directory on the systems that keep every one of theirs under
    // one root.
    .replace(/[\\/](?:Users|home)[\\/][^\s"'`()[\]<>]*/gu, lastSegment);
}

/** The tab groups, as they are at this instant and with no `await` inside. */
function groupsNow() {
  return vscode.window.tabGroups.all.map((group) => ({
    column: group.viewColumn,
    active: group.isActive,
    tabs: group.tabs.map((tab) => neutral(tab.label)),
    // The one thing the prototype never recorded, and the reason it could not
    // answer "is our strip exactly one group": a LABEL does not say whether a
    // tab is a terminal, and every assertion about the strip needs that.
    terminals: group.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal).length,
  }));
}

/** The editor's grid, or the sentence it refused with. */
async function gridNow() {
  try {
    return { grid: await vscode.commands.executeCommand('vscode.getEditorLayout'), refused: null };
  } catch (error) {
    return { grid: null, refused: String(error) };
  }
}

/**
 * One sighting: the tab groups and the grid, from ONE instant.
 *
 * The grid has to be awaited and the groups do not, so a naive reading takes the
 * two from either side of that await -- which is the second defect the prototype
 * had, and it is not theoretical: 349 of its 421 lines hold a group count the
 * grid disagrees with. Here the groups are read on both sides and the pair is
 * taken again if they moved; a pair that is still moving after three tries is
 * written down as torn rather than passed off as a fact.
 */
async function sighting(what) {
  let before = groupsNow();
  let grid = null;
  let refused = null;
  let after = before;
  let torn = false;
  for (let attempt = 0; attempt < UNTORN_ATTEMPTS; attempt += 1) {
    before = groupsNow();
    const answer = await gridNow();
    grid = answer.grid ?? null;
    refused = answer.refused;
    after = groupsNow();
    torn = JSON.stringify(before) !== JSON.stringify(after);
    if (!torn) {
      break;
    }
  }
  return {
    kind: 'snapshot',
    sitting: SITTING,
    ordinal: history.length + 1,
    at: new Date().toISOString(),
    // Both of these are put through `neutral` at the one point every line of the
    // recording passes through, rather than at each of the dozen places that
    // build a reason: a scrub somebody has to remember to call is one that gets
    // forgotten by the next message somebody adds.
    what: neutral(what),
    sinceActivationMs: Date.now() - activatedAt,
    productAlreadyActive,
    workspaceStorage,
    torn,
    /*
     * Whether this window held the keyboard at the instant this was taken.
     *
     * Three of the nine points read the grid below, and `vscode.getEditorLayout`
     * answers for the part of the editor its ACTIVE group is in (measured
     * 2026-08-25, twelve settled sightings of twelve). A window without the
     * keyboard is a window whose active group belongs to whatever took it -- the
     * fork's login window, which the owner reported popping up during these very
     * runs on 2026-08-25, among them. The judge refuses such a reading rather
     * than calling it a defect; deciding that here would be the measurer
     * judging.
     */
    focused: vscode.window.state.focused,
    grid,
    gridRefused: refused === null ? null : neutral(refused),
    groups: after,
  };
}

/**
 * What makes two sightings the same picture: the groups, the grid, and whether
 * the window held the keyboard.
 *
 * The keyboard is in here rather than left out as "not part of the layout"
 * precisely because the judge now refuses a layout read without it. A pair of
 * sightings differing only by the flag is two different facts, and collapsing
 * the second into the first would throw away the only line saying when the
 * window lost it.
 */
function picture(snapshot) {
  return JSON.stringify([snapshot.groups, snapshot.grid, snapshot.gridRefused, snapshot.focused]);
}

/**
 * Takes a sighting and writes it down, one at a time.
 *
 * Serialised through one promise because the events that ask for sightings
 * arrive in bursts of a dozen a millisecond apart, and two readings interleaved
 * inside each other's `await` would be exactly the torn pair the retry above
 * exists to avoid.
 *
 * Sightings identical to the one before them are kept in memory and not written:
 * a burst of twelve is one picture, and the prototype's file was 127 KB of
 * mostly that. `keep` forces a line out whatever it looks like -- the three
 * sightings the judge reads by name are never collapsed into a predecessor.
 */
function note(what, keep = false) {
  writing = writing.then(async () => {
    const snapshot = await sighting(what);
    const last = history[history.length - 1];
    history.push(snapshot);
    if (!keep && last !== undefined && picture(last) === picture(snapshot)) {
      return;
    }
    if (LOG !== undefined) {
      appendFileSync(LOG, `${JSON.stringify(snapshot)}\n`, 'utf8');
    }
  });
  return writing;
}

/**
 * Waits for something the editor has ANNOUNCED, not for a number of
 * milliseconds.
 *
 * `ready` is asked again on every tab and group event -- that is what `lastChangeAt`
 * is moved by -- and the clock below is looked at rather than slept through, so
 * that "it never happened" ends as a refusal instead of a hang.
 */
async function until(what, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ready()) {
      return true;
    }
    if (Date.now() > deadline) {
      await note(`gave up waiting for ${what} after ${String(ms)} ms`, true);
      return false;
    }
    await delay(TICK_MS);
  }
}

/** How many terminals of ours are on screen, wherever they are. */
function terminalsOnScreen() {
  return groupsNow().reduce(
    (sum, group) => sum + group.terminals,
    0
  );
}

/**
 * From this sitting's activation to the first moment the window held what it
 * ended up holding.
 *
 * Read back out of the sightings rather than timed with a stopwatch, because the
 * moment worth naming is not one this file can be standing at when it happens:
 * "everything came back" is only knowable once nothing more comes.
 */
function restoredMs() {
  const settled = history.filter((one) => one.what === SETTLED).pop();
  if (settled === undefined) {
    return null;
  }
  const wanted = settled.groups.reduce((sum, group) => sum + group.terminals, 0);
  if (wanted === 0) {
    return null;
  }
  const first = history.find(
    (one) => one.groups.reduce((sum, group) => sum + group.terminals, 0) === wanted
  );
  return first === undefined ? null : first.sinceActivationMs;
}

async function activate(context) {
  // These two first, before any `await` and before anything is asked of the
  // product: from here on nothing the editor does to its groups goes unseen.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      lastChangeAt = Date.now();
      void note('the groups changed');
    })
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      lastChangeAt = Date.now();
      void note('the tabs changed');
    })
  );

  /*
   * And the keyboard, which is not a tab event and must not be counted as one.
   *
   * `lastChangeAt` is deliberately NOT moved here: quiet is the window's own
   * quiet, and a sitting whose settling could be pushed back by something
   * outside the editor taking the focus would be waiting on a person's desktop
   * rather than on the product. What this subscription buys is that a loss and
   * a recovery BETWEEN two sightings are in the recording at all -- `picture()`
   * counts the flag, so a sighting that differs only by it is written down
   * rather than collapsed into its predecessor.
   */
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      void note(`the window ${state.focused ? 'took' : 'lost'} the keyboard`);
    })
  );

  const product = vscode.extensions.getExtension(PRODUCT);
  productAlreadyActive = product !== undefined && product.isActive;
  activatedAt = Date.now();
  lastChangeAt = Date.now();
  /*
   * The editor's key for THIS FOLDER, which is the directory one level above the
   * one this extension is handed: `storageUri` is
   * `<user data>/User/workspaceStorage/<key>/<publisher>.<name>`, so the last
   * segment is this extension's own identity and is the same in every window
   * ever opened. The first run of this stand recorded exactly that and reported
   * point 0 green about it -- a key that cannot differ is not a key.
   */
  workspaceStorage =
    context.storageUri === undefined ? null : basename(dirname(context.storageUri.fsPath));

  await note(ACTIVATED, true);

  if (product === undefined) {
    await note('the product is not in this host at all', true);
    finish();
    return;
  }
  // A readiness signal and not a wait: the editor resolves this when the
  // product's own `activate` has returned.
  await product.activate();
  await note('the product is up', true);

  for (let nth = 1; nth <= MAKE; nth += 1) {
    // The way the owner does it: the list has the focus and the command is the
    // one behind the plus. That entry is what put a strip at ninety per cent of
    // the height, and an internal call would have been a different question.
    await run('gripterm.terminals.focus');
    await run('gripterm.newTerminal');
    const wanted = nth;
    await until(
      `terminal ${String(nth)} to appear`,
      () => terminalsOnScreen() >= wanted,
      TERMINAL_WITHIN_MS
    );
  }

  await until(
    'the window to stop changing',
    () => Date.now() - lastChangeAt > QUIET_MS,
    SETTLES_WITHIN_MS
  );
  await note(SETTLED, true);

  if (OPEN_A_FILE && PROJECT !== undefined) {
    await openAFileOverTheStrip();
  }

  finish();
}

/**
 * The complaint of 2026-08-22, reproduced on purpose: a person whose strip has
 * the focus opens a file, and it lands IN the strip beside the terminals.
 *
 * The strip is focused first and the file is then opened with no column named,
 * so that the EDITOR decides where it goes. Naming a column here would be the
 * stand answering its own question.
 */
async function openAFileOverTheStrip() {
  const strip = vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal));
  if (strip === undefined) {
    await note('there was no strip to open a file over', true);
    return;
  }
  const focus = FOCUS_GROUP[strip.viewColumn - 1];
  if (focus === undefined) {
    await note(`the strip is in column ${String(strip.viewColumn)}, which no command can focus`, true);
    return;
  }
  await run(focus);
  const file = join(PROJECT, 'README.md');
  if (!existsSync(file)) {
    // By its name and not by its path. The folder is the runner's own and the
    // runner prints where it is; the path here would only add the name of
    // whoever the machine belongs to. `neutral` would cut it anyway -- this
    // says the same thing without needing to be cut.
    await note(`there is no ${basename(file)} in the project folder to open`, true);
    return;
  }
  const before = vscode.window.tabGroups.all.reduce((sum, group) => sum + group.tabs.length, 0);
  await run('vscode.open', vscode.Uri.file(file));
  await until(
    'the file to appear somewhere',
    () => vscode.window.tabGroups.all.reduce((sum, group) => sum + group.tabs.length, 0) > before,
    TERMINAL_WITHIN_MS
  );
  await until(
    'the window to stop changing after the file opened',
    () => Date.now() - lastChangeAt > QUIET_MS,
    SETTLES_WITHIN_MS
  );
  await note(FILE_OPENED, true);
}

/** A command, with whatever it threw written down instead of thrown away. */
async function run(command, ...args) {
  try {
    return await vscode.commands.executeCommand(command, ...args);
  } catch (error) {
    await note(`${command} threw: ${String(error)}`, true);
    return undefined;
  }
}

/**
 * The signal the runner outside is waiting for, and the one number only this
 * side knows.
 *
 * A file rather than a length of time, because a sitting that took longer than
 * somebody guessed is a sitting measured half-way through.
 */
function finish() {
  if (DONE === undefined) {
    return;
  }
  writing = writing.then(() => {
    writeFileSync(DONE, `${JSON.stringify({ sitting: SITTING, restoredMs: restoredMs() })}\n`, 'utf8');
  });
  void writing;
}

function deactivate() {
  // Nothing, and deliberately. `vscode.getEditorLayout` answers
  // `Canceled: Canceled` on the way down -- every time it was measured, in three
  // sittings of 2026-08-21 -- so a sighting taken here would be the one line of
  // every sitting with no grid in it, standing where a reader looks last.
}

module.exports = { activate, deactivate };
