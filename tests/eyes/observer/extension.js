/*
 * The scene builder of the eyes. It arranges what is to be looked at, through
 * the very API a person's own clicks go through, and it LOOKS AT NOTHING. The
 * looking is `run.mjs`, over the DevTools protocol, at the workbench's own DOM.
 *
 * **Why the two are separate programs, and why that is the whole idea.** Ш10
 * exists because a button did not draw THREE TIMES while the context key it
 * hangs on was measured to be correct -- so every question this file could
 * answer about that button ("is the command registered", "is the key set", "is
 * the view revealed") was already answered YES on a build where nobody could
 * see it. An extension cannot read the workbench's DOM, and that is exactly the
 * organ that was missing. So this half arranges and asserts nothing; the other
 * half sees.
 *
 * **Turns, not a script.** The two halves take turns through files, because the
 * driver has work to do between the scenes -- Cursor covers a fresh profile with
 * a full-window onboarding sheet, and nothing can be seen until that is out of
 * the way (measured 2026-08-25). So this writes a scene, waits for the driver to
 * say it has looked, and only then disturbs the window again.
 *
 * **Plain CommonJS on purpose**, like `tests/stand/observer/extension.js`: an
 * extension the editor loads from source, with no build step between what is
 * written here and what runs.
 */

const vscode = require('vscode');
const { writeFileSync, existsSync } = require('node:fs');

/** The product, by its exact identity: `/gripterm/i` would also match this file. */
const PRODUCT = 'gripterm-placeholder.gripterm';

const SCENES = process.env.GRIPTERM_EYES_SCENES;
const MAKE = Number(process.env.GRIPTERM_EYES_MAKE ?? '2');

/** How long the observer waits for the driver between scenes before giving up. */
const DRIVER_WITHIN_MS = 300_000;
/** How long one asked-for terminal has to appear. */
const TERMINAL_WITHIN_MS = 90_000;
/** How long a closed terminal has to be gone from the window. */
const CLOSES_WITHIN_MS = 60_000;
/** How long the window is given to stop changing after a scene is arranged. */
const QUIET_MS = 2500;

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

/**
 * Waits for something to become true, with a ceiling.
 *
 * A ceiling and not a hope: "never happens" and "has not happened yet" look
 * identical to a poll, and without a deadline the first of them hangs a run
 * instead of reddening it.
 */
async function until(what, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ready()) {
      return true;
    }
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${String(ms)} ms`);
    }
    await sleep(200);
  }
}

/** Every tab in the window, by the label a person reads on it. */
function tabLabels() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => tab.label);
}

/** The terminals of this window, by name -- which is what pairs a row with a tab. */
function terminalNames() {
  return vscode.window.terminals.map((terminal) => terminal.name);
}

/**
 * The terminals THIS RUN made, in the order it made them.
 *
 * Not `vscode.window.terminals`, and the difference is a defect this file had
 * for exactly one run: Cursor opens a terminal of its OWN named after itself, it
 * sorts first, and scene three closed it instead of ours. A window's terminals
 * are not a run's terminals, and the eyes may only disturb what they made.
 */
const mine = [];

/** Ours that are still open, which is what a row and a tab can both be found for. */
function stillOpen() {
  const open = terminalNames();
  return mine.filter((name) => open.includes(name));
}

/** What the API believes, at the moment a scene is handed over to be looked at. */
function believed() {
  const group = vscode.window.tabGroups.activeTabGroup;
  return {
    terminals: stillOpen(),
    // Every terminal in the window, ours and the editor's own, so that a reader
    // of the recording can see what else was on the screen at the time.
    allTerminals: terminalNames(),
    tabs: tabLabels(),
    activeTab: group?.activeTab?.label ?? null,
    activeTerminal: vscode.window.activeTerminal?.name ?? null,
  };
}

function handOver(name, extra) {
  writeFileSync(`${SCENES}-${name}.json`, `${JSON.stringify({ ...believed(), ...extra }, null, 2)}\n`, 'utf8');
}

/** Waits until the driver says it has finished looking at the scene before this one. */
async function theDriverHasLooked(name) {
  await until(`the driver to say it looked at ${name}`, () => existsSync(`${SCENES}-${name}.looked`), DRIVER_WITHIN_MS);
}

/**
 * Makes one terminal the way the owner does: the list has the focus and the
 * command is the one behind the plus.
 *
 * An internal call would be a different question -- `tests/stand/observer` says
 * the same and for the same reason.
 */
async function makeATerminal() {
  const before = terminalNames();
  await vscode.commands.executeCommand('gripterm.terminals.focus');
  await vscode.commands.executeCommand('gripterm.newTerminal');
  await until(
    'a terminal this run asked for to appear',
    () => terminalNames().some((name) => !before.includes(name)),
    TERMINAL_WITHIN_MS
  );
  const made = terminalNames().find((name) => !before.includes(name));
  mine.push(made);
  return made;
}

async function activate() {
  try {
    const ours = vscode.extensions.getExtension(PRODUCT);
    if (ours === undefined) {
      handOver('one', { product: 'ABSENT', error: 'the product is not in this host at all' });
      return;
    }
    // A readiness signal and not a wait: the editor resolves this when the
    // product's own `activate` has returned.
    await ours.activate();

    for (let nth = 1; nth <= MAKE; nth += 1) {
      await makeATerminal();
    }
    await sleep(QUIET_MS);

    // Scene one is handed over BEFORE anything is revealed, because the driver
    // has to clear the editor's own first-run sheet before any part of this
    // window can be seen at all.
    handOver('one', { product: 'present', error: null });
    await theDriverHasLooked('one');

    /*
     * Scene two: the list revealed and a terminal in front.
     *
     * Both are the conditions the two S13 buttons hang on -- one lives in the
     * title of the list, the other in the title of the editor a terminal is in
     * -- and neither is asserted here. Whether the editor DREW either of them is
     * the driver's question, and the whole point of Ш10 is that this side of the
     * API answers yes to it either way.
     */
    const did = [];
    for (const command of ['workbench.view.explorer', 'gripterm.terminals.focus']) {
      try {
        await vscode.commands.executeCommand(command);
        did.push(command);
      } catch (failed) {
        did.push(`${command} FAILED: ${String(failed?.message ?? failed)}`);
      }
      await sleep(600);
    }
    // The terminal last made is put in front, so that `gripterm.terminalInFront`
    // is true and the editor has every reason to draw the button that hangs on it.
    const lastName = stillOpen()[stillOpen().length - 1];
    const last = vscode.window.terminals.find((terminal) => terminal.name === lastName);
    if (last !== undefined) {
      last.show(true);
      await until('a terminal to be the active one', () => vscode.window.activeTerminal !== undefined, TERMINAL_WITHIN_MS);
    }
    await sleep(QUIET_MS);
    handOver('two', { did, error: null });
    await theDriverHasLooked('two');

    /*
     * Scene three: a terminal restarted, which is where "залипло" lives.
     *
     * The plan is exact about this -- the colour of the badge is checked AFTER a
     * terminal is restarted, because the table of state to colour is already
     * checked whole and is not where the defect is. What is not checked anywhere
     * is which TAB a record walks behind once the terminals under it have
     * changed. So one is closed, the window is given time to notice, and a fresh
     * one is made: after that every row and the tab of the same name must be
     * telling the same story, and the driver is the one that can see whether
     * they are.
     */
    // Ours, by name, and never `terminals[0]`: see `mine`.
    const closedName = stillOpen()[0] ?? null;
    const closing = vscode.window.terminals.find((terminal) => terminal.name === closedName);
    if (closing !== undefined) {
      closing.dispose();
      await until(
        `the closed terminal ${String(closedName)} to be gone from the window`,
        () => !terminalNames().includes(closedName),
        CLOSES_WITHIN_MS
      );
    }
    await sleep(QUIET_MS);
    await makeATerminal();
    await vscode.commands.executeCommand('gripterm.terminals.focus');
    await sleep(QUIET_MS);
    handOver('three', { closedName, error: null });
    await theDriverHasLooked('three');

    /*
     * Scenes four, five and six: the button PRESSED, and both ways.
     *
     * The customer asked for one thing in one sentence -- "распахивала бы
     * панель на всю высоту экрана... и после при повторном клике возвращалась
     * бы на место" -- and until now nothing had measured either half in the
     * fork it was asked about. The live suites measure both, in VS Code, off
     * `vscode.getEditorLayout`; this measures them where the customer is, off
     * the boxes the workbench actually laid out.
     *
     * A FILE is put in front first, and that is not decoration: the editor's
     * toggle names no target and takes the ACTIVE group, so a run that pressed
     * the button from the terminal's own tab bar would pass while maximising
     * somebody's source file everywhere else.
     */
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder !== undefined) {
      const readme = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'README.md'));
      await vscode.window.showTextDocument(readme, { viewColumn: vscode.ViewColumn.One });
      await until(
        'a file of the person`s own to be the editor in front',
        () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText,
        TERMINAL_WITHIN_MS
      );
    }
    await sleep(QUIET_MS);
    handOver('four', { pressed: 0, error: null });
    await theDriverHasLooked('four');

    await vscode.commands.executeCommand('gripterm.maximizeTerminals');
    await sleep(QUIET_MS);
    handOver('five', { pressed: 1, error: null });
    await theDriverHasLooked('five');

    await vscode.commands.executeCommand('gripterm.maximizeTerminals');
    await sleep(QUIET_MS);
    handOver('six', { pressed: 2, error: null });
    await theDriverHasLooked('six');
  } catch (failed) {
    // Written to whichever scene has not been handed over yet, so that a driver
    // waiting on a file gets an answer instead of a deadline.
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) {
      if (!existsSync(`${SCENES}-${name}.json`)) {
        handOver(name, { error: String(failed?.message ?? failed) });
      }
    }
  }
}

module.exports = { activate };
