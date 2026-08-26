/*
 * The eyes: a driver that opens a real editor, attaches to its workbench over
 * the DevTools protocol, and asks the DOM what it is actually drawing.
 *
 * **Why this exists at all.** The maximise button did not draw THREE TIMES, and
 * the last time the context key it hangs on was MEASURED to be correct
 * (`packages/extension/src/commands/maximize-terminals.ts` says so in its own
 * comment). Every check this repository owns would have passed on that build:
 * the manifest contributes the button, the command is registered, the key is
 * set. What no check could do was LOOK. That organ is this file.
 *
 * **Zero new dependencies, and that was measured before it was chosen.**
 * `wdio-vscode-service` was the plan's first suggestion; it is not needed and
 * would not have helped. Cursor's Electron 40.10.3 answers `--remote-debugging-port`
 * with an ordinary Chrome DevTools endpoint (`Chrome/144.0.7559.236`), Node 22
 * has `fetch` and a global `WebSocket`, and between them that is a whole driver.
 * No chromedriver, no browser download, nothing fetched at first run, nothing to
 * keep in step with the fork's Electron.
 *
 * **What proves these eyes would catch S26 -- and the date it stopped being an
 * assumption.** Until 2026-08-26 the tab-against-row sightings had answered
 * green or REFUSED and never once RED, so nothing said they would catch the
 * defect they exist for. That is this file's own mistake turned on itself: an
 * absence read as an answer. A positive control was put under them that day and
 * then removed. It was a STAND-IN EXTENSION registering a second
 * `FileDecorationProvider` over one of the `vscode-terminal:` uris the product
 * colours a tab through -- so the disagreement was drawn by the EDITOR, through
 * the product's own channel, with nothing of the eyes in the picture. In one run
 * of VS Code 1.134.0 the two sightings read 2 green before it and, with the
 * leftmost tab decorated `charts.purple`, RED for that tab ("it is coloured
 * rgb(173, 128, 215) where rgb(134, 207, 134) was due") and GREEN for the other,
 * in the same look. A second control was measured and NOT chosen: the driver
 * painting that tab's icon itself reddened identically -- 1 red, 1 green, same
 * shape -- but a driver that writes into the DOM it reads cannot tell "the eyes
 * see the colour" from "the eyes see what they wrote", while a decoration the
 * editor draws can. Neither control is in this file now; what is left of them is
 * this paragraph and `judge.test.ts`. WHAT IS THEREFORE STILL UNPROVEN: that a
 * later build would still be caught, since nothing repeats the control.
 *
 * **S25, and the one thing here that is simulated.** An agent hitting a
 * permission prompt cannot be scheduled, so the observer posts the CLI's own
 * `PermissionRequest` hook to the product's own loopback endpoint, with the
 * token and the session id that terminal was launched with -- both readable from
 * `creationOptions` by any extension in the window. What is stood in for is the
 * AGENT. The parser, the state machine, the notifier, the toast and the button
 * on it are the product's own, and so is where the button leads.
 *
 * **What it will not touch.** Every window this starts carries a
 * `--user-data-dir`, an `--extensions-dir` and a `gripterm.storage.path` of its
 * own, all three under `.vscode-test/`, and the run refuses to start if the
 * store it is about to hand over is not one of ours. The store the person who
 * owns this machine keeps their terminals in is never opened.
 *
 * **What it closes.** Only windows that did not exist when it started. The pids
 * are taken before the window is launched and the difference is what gets
 * `CloseMainWindow()` -- never a kill by name, which would close the window the
 * owner is working in.
 *
 * **The one thing it does to the editor, and why it is written down.** Cursor
 * started on a fresh profile covers the entire window with its own first-run
 * sheet (`div.onboarding-v2-overlay`, z-index 2549, measured 2026-08-25). Behind
 * it the workbench is built and working; in front of it nothing can be seen and
 * no click lands. The eyes REMOVE that element and record how many they removed,
 * because a run that quietly edited the thing it was measuring would be worth
 * nothing. Nothing else about the window is touched.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostUserData, runStore } from '../../tools/host-user-data.mjs';

const require = createRequire(import.meta.url);

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LABEL = 'eyes';

// CommonJS, and required rather than imported: three module systems need this
// one function. See the head of `tools/fork-build.js`.
const { forkBuild } = require(join(REPO, 'tools', 'fork-build.js'));
// The judging half, compiled by `pnpm run build:eyes`. Required rather than
// imported for the same reason: this file is ESM and that one is compiled to CJS.
const { judge } = require(join(REPO, 'out', 'tests', 'eyes', 'judge.js'));

const BASE = join(REPO, '.vscode-test');
const STORE = runStore(LABEL);
const EXTENSIONS = join(BASE, `extensions-${LABEL}`);
const OUTPUT = join(BASE, `${LABEL}-output`);
const PROJECT = join(BASE, `${LABEL}-project`);
const PRODUCT = join(REPO, 'packages', 'extension');
const OBSERVER = join(REPO, 'tests', 'eyes', 'observer');
const SCENES = join(OUTPUT, 'scene');
const RECORDING = join(OUTPUT, 'recording.json');

/**
 * The verdict, as JSON, for whoever has to do arithmetic on it.
 *
 * Written HERE rather than recomputed in the gate, so that the gate judges the
 * run that happened -- and it lands inside `OUTPUT`, which `prepare()` deletes at
 * the start of every run, so a gate cannot read yesterday's answer as today's.
 */
const VERDICT = join(OUTPUT, 'verdict.json');

/** How many terminals the scene is built with. Two: enough for a row to be paired with the wrong tab. */
const TERMINALS = 2;

/**
 * The size the workbench is told to lay itself out at.
 *
 * It matters, and it is the difference between a measurement and an accusation.
 * A toolbar too narrow for its buttons does not draw them all -- it folds the
 * last ones into `More Actions...` -- so "our button is not in that bar" and
 * "that bar was 220 pixels wide" are two different findings and only one of them
 * is a defect. Measured 2026-08-25: a Cursor window opened at 1000x800 gives the
 * terminal's group 220 px, and VS Code at the same size gives it 792 px, because
 * the fork keeps a chat pane and a sidebar of its own beside it. So the eyes fix
 * the layout size rather than inheriting whatever the desktop felt like giving
 * them, and the number goes into the recording.
 *
 * `Emulation.setDeviceMetricsOverride` and not a window resize: the OS window is
 * the owner's desktop, and Electron ignored `Browser.setWindowBounds` here
 * anyway (measured the same day).
 */
const LAYOUT = { width: 1920, height: 1200 };

/** How long the whole window is given to come up and answer the debugging endpoint. */
const UP_WITHIN_MS = 180_000;
/** How long one scene is given to be handed over by the observer. */
const SCENE_WITHIN_MS = 300_000;
/** How long a window is given to be gone after it was asked to close. */
const CLOSES_WITHIN_MS = 60_000;

/**
 * How long a badge is given to catch up with the record before the disagreement
 * counts as a defect.
 *
 * This number is the difference between measuring "залипло" and measuring a
 * race, and it was put here because the eyes caught the race on their fourth
 * run: a terminal made a moment earlier was `launching` (blue) on its tab and
 * already `idle` (green) on its row, because the two are drawn by two different
 * subscriptions and one of them had not been told yet. A tab that catches up
 * inside a second is not a badge that stuck; a tab that never catches up is.
 *
 * So the eyes LOOK AGAIN, on the state of the picture and not on a sleep, and
 * the time they had to wait goes into the verdict where a reader can see it. A
 * disagreement that outlives this ceiling is red, and the red says how long it
 * lasted. Fifteen seconds because it is far past anything a redraw needs and far
 * short of a person's patience.
 */
const AGREES_WITHIN_MS = 15_000;
const POLL_MS = 500;

/**
 * The editors this looks for, in this order.
 *
 * Cursor first because every one of the defects Ш10 is about was reported in
 * Cursor; VS Code is the fallback and is worth running on purpose, because the
 * two disagreeing is the strongest evidence this driver can produce. Neither is
 * downloaded: this wants the editor a person actually uses.
 */
const EDITORS = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
];

function say(line = '') {
  console.log(line);
}

function step(what) {
  console.log(`\n=== ${what}`);
}

function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
}

/**
 * The editor windows on this machine right now, by pid.
 *
 * Every process is enumerated and the names matched here rather than asking
 * `Get-Process -Name Cursor,Code`: a name in that list nothing is running under
 * is a non-terminating error, and PowerShell then exits 1 with the right answer
 * on stdout, which `execFileSync` reads as a crash. The stand learnt this the
 * hard way; see the same function in `tests/stand/run.mjs`.
 */
function editorWindows() {
  const out = powershell(
    '@(Get-Process | Where-Object {' +
      ' ($_.ProcessName -eq \'Cursor\' -or $_.ProcessName -eq \'Code\')' +
      ' -and $_.MainWindowHandle -ne 0 }) | ForEach-Object { $_.Id }'
  );
  return out.length === 0 ? [] : out.split(/\r?\n/u).map((line) => Number(line.trim()));
}

/** Asks one window to close the way a person closes it, so that deactivation runs. */
function closeWindow(pid) {
  powershell(
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue;` +
      ' if ($p) { $null = $p.CloseMainWindow() }'
  );
}

async function until(what, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await ready();
    if (answer !== null && answer !== undefined) {
      return answer;
    }
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${String(ms)} ms`);
    }
    await new Promise((wake) => setTimeout(wake, POLL_MS));
  }
}

/**
 * A port nothing is listening on.
 *
 * Asked of the operating system rather than picked, because a fixed port is a
 * run that fails the day somebody has something else on it -- and on a machine
 * whose owner has their own editor open, that day is today.
 */
function freePort() {
  return new Promise((settle, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => { settle(port); });
    });
  });
}

async function endpoint(url) {
  try {
    const answer = await fetch(url);
    return answer.ok ? await answer.json() : null;
  } catch {
    // Not yet listening is the ordinary case here, and it is indistinguishable
    // from never going to listen except by the deadline `until` holds.
    return null;
  }
}

/** One DevTools session over a target's websocket. */
function session(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  let next = 1;
  const opened = new Promise((settle, fail) => {
    socket.addEventListener('open', () => { settle(); });
    socket.addEventListener('error', () => { fail(new Error(`could not open a DevTools session at ${url}`)); });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const pending = waiting.get(message.id);
    if (pending !== undefined) {
      waiting.delete(message.id);
      pending(message);
    }
  });
  return {
    opened,
    send(method, params = {}) {
      const id = next;
      next += 1;
      return new Promise((settle) => {
        waiting.set(id, settle);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

// --- what the page is asked -------------------------------------------------

/**
 * The one expression the workbench evaluates for us, and everything the eyes
 * know comes back from it.
 *
 * It is a string of source rather than a function because it runs in ANOTHER
 * PROCESS -- the workbench renderer -- and nothing of this file's scope exists
 * there. It asserts nothing: it reports boxes, classes and colours, and every
 * judgement about them is made in `judge.ts`, which can be checked without an
 * editor.
 */
const LOOK = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const label = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || '').split('\\n')[0];
  const codicon = (e) => [...e.classList].filter((c) => c.startsWith('codicon-')).join(' ');
  const drawnOf = (item) => {
    const a = item.querySelector('a, .action-label') || item;
    return { label: label(a) || label(item), codicon: codicon(a), box: box(item),
             visible: item.checkVisibility(), color: null };
  };

  const editorActionBars = [...document.querySelectorAll('.editor-actions')].map((bar) => {
    const group = bar.closest('.editor-group-container');
    const tabs = group === null ? [] : [...group.querySelectorAll('.tab')]
      .filter((t) => t.classList.contains('active'))
      .map((t) => (t.querySelector('.label-name') || t).textContent.trim());
    return { activeTab: tabs[0] || null,
             group: group === null ? null : box(group),
             items: [...bar.querySelectorAll('.action-item')].map(drawnOf) };
  });

  const paneHeaders = [...document.querySelectorAll('.pane-header')].map((header) => ({
    title: (header.querySelector('.title') || header).textContent.trim(),
    box: box(header),
    items: [...header.querySelectorAll('.action-item')].map(drawnOf),
  }));

  const rows = [...document.querySelectorAll('.monaco-list-row')].map((row) => {
    const icon = row.querySelector('[class*=codicon-]');
    const name = row.querySelector('.label-name') || row.querySelector('.monaco-icon-name-container');
    return { label: (name === null ? row.textContent : name.textContent).trim(),
             codicon: icon === null ? '' : codicon(icon),
             box: box(row), visible: row.checkVisibility(),
             color: icon === null ? null : getComputedStyle(icon).color };
  });

  // The notifications, as the workbench draws them: the toast itself, what it
  // says, the buttons it offers, and the controls the EDITOR puts on every one
  // of them (Clear Notification, Configure Notification) whoever raised it.
  const toasts = [...document.querySelectorAll('.notifications-toasts .notification-toast')].map((toast) => ({
    message: (toast.querySelector('.notification-list-item-message') || toast).textContent.trim(),
    box: box(toast),
    visible: toast.checkVisibility(),
    buttons: [...toast.querySelectorAll('.monaco-button')].map((one) => ({
      label: one.textContent.trim() || label(one),
      codicon: codicon(one), box: box(one), visible: one.checkVisibility(), color: null,
    })),
    ownControls: [...toast.querySelectorAll('.notification-list-item-toolbar-container .action-item')].map(drawnOf),
  }));

  // Whether a menu is open right now. It is what a press on a "More Actions..."
  // lands as, and therefore one of the two ways a control can show that a press
  // reached it at all.
  const menus = [...document.querySelectorAll('.context-view')]
    .filter((e) => e.checkVisibility() && e.querySelector('.monaco-menu') !== null).length;

  // The parts of the workbench themselves, laid out or not. This is what turns
  // "our button was not in that bar" into "that bar is display:none in this
  // fork", which is a different finding and not ours -- measured 2026-08-25 in
  // a Cursor on a fresh profile and true of its whole side bar.
  const parts = ['.part.activitybar', '.part.sidebar', '.part.panel', '.part.auxiliarybar', '.part.editor', '.part.statusbar']
    .map((selector) => {
      const part = document.querySelector(selector);
      return { selector,
               display: part === null ? 'absent' : getComputedStyle(part).display,
               box: part === null ? { x: 0, y: 0, w: 0, h: 0 } : box(part),
               visible: part !== null && part.checkVisibility() };
    });

  // The status bar, for the editor's own notification bell: it is drawn whether
  // or not anything has been raised, so it is what proves the eyes got a look
  // at the part of the window a toast would appear in.
  const statusBar = [...document.querySelectorAll('.statusbar .statusbar-item')].map((item) => ({
    label: label(item.querySelector('a') || item) || item.textContent.trim(),
    codicon: codicon(item.querySelector('[class*=codicon-]') || item),
    box: box(item),
    visible: item.checkVisibility(),
    color: null,
  }));

  const tabs = [...document.querySelectorAll('.tabs-container .tab')].map((tab) => {
    const icon = tab.querySelector('.tab-label [class*=codicon-], .monaco-icon-label[class*=codicon-], [class*=codicon-]:not(.tab-actions [class*=codicon-])');
    const name = tab.querySelector('.label-name');
    const close = tab.querySelector('.tab-actions .action-item');
    const group = tab.closest('.editor-group-container');
    return { label: (name === null ? tab.textContent : name.textContent).trim(),
             codicon: icon === null ? '' : codicon(icon),
             box: box(tab), visible: tab.checkVisibility(),
             color: icon === null ? null : getComputedStyle(icon).color,
             // Which tab a person would call "in front": the active one of the
             // active group. Two groups have an active tab each; only one of
             // them is what somebody is looking at.
             active: tab.classList.contains('active'),
             inActiveGroup: group !== null && group.classList.contains('active'),
             close: close === null ? null : drawnOf(close) };
  });

  // Every group of the editor area, with the tabs on it. What "maximised" means
  // to a person is this and nothing else: one group over the whole area and the
  // others with no height left.
  const editorGroups = [...document.querySelectorAll('.editor-group-container')].map((g) => ({
    box: box(g),
    tabs: [...g.querySelectorAll('.tabs-container .tab')].map((t) => (t.querySelector('.label-name') || t).textContent.trim()),
  }));

  // Anything anywhere in the window carrying one of the labels this run cares
  // about, wherever it is. "Not in that bar" and "not in this window" are two
  // findings, and the eyes used to be able to report only the first.
  const named = /Maximise the Terminals/iu;
  const anywhere = [...document.querySelectorAll('[aria-label], [title]')]
    .filter((e) => named.test(label(e)))
    .slice(0, 40)
    .map(drawnOf);

  return JSON.stringify({
    onboardingOverlays: document.querySelectorAll('.onboarding-v2-overlay').length,
    editorActionBars, paneHeaders, rows, tabs, anywhere, editorGroups, toasts, statusBar, parts, menus,
  });
})()`;

/** Runs `LOOK` in the workbench and hands back what it said. */
async function look(cdp) {
  const answer = await cdp.send('Runtime.evaluate', { expression: LOOK, returnByValue: true, awaitPromise: true });
  const value = answer?.result?.result?.value;
  if (typeof value !== 'string') {
    const why = JSON.stringify(answer?.result?.exceptionDetails ?? answer).slice(0, 400);
    throw new Error(`the workbench would not answer what it is drawing: ${why}`);
  }
  return JSON.parse(value);
}

// --- turning what was seen into sightings -----------------------------------

/** Whether a label belongs to a control of OURS. Ours all say so out loud. */
function isOurs(label) {
  return label.startsWith('Gripterm');
}

const MAXIMISE = /Maximise the Terminals/iu;

/**
 * S13, in the title of the editor a terminal is in.
 *
 * This is the placement the customer reported and the one
 * `maximize-terminals.ts` says Cursor refused three times. The anchors are every
 * OTHER item in the very same bar -- `Split Editor Right`, `More Actions...` --
 * all of them the editor's own, so a bar with them in it and our button missing
 * is a bar the eyes could see and the product is not in.
 */
function s13InTheEditorTitle(seen, terminals) {
  const bar = seen.editorActionBars.find((one) => one.activeTab !== null && terminals.includes(one.activeTab))
    ?? { activeTab: null, group: null, items: [] };
  const width = bar.group === null ? 'a group with no box' : `a group ${String(bar.group.w)} px wide`;
  return {
    point: 1,
    scenario: 'S13',
    what:
      `the maximise button in the title bar of the editor a terminal is in (${width}, ` +
      `active tab ${JSON.stringify(bar.activeTab)})`,
    ours: bar.items.find((one) => MAXIMISE.test(one.label)) ?? null,
    anchors: bar.items.filter((one) => !isOurs(one.label)),
    wanted: null,
  };
}

/**
 * S13, in the title of the list of terminals -- where the button was MOVED after
 * Cursor refused to draw it in the editor title.
 *
 * The anchor here is the editor's own `More Actions...`, which the workbench puts
 * in the same header as our two buttons. A header where that is drawn and ours
 * is not is our defect; a header where neither is drawn is a header nobody got
 * a look at, and the judge refuses it.
 */
function s13InTheViewTitle(seen) {
  const header = seen.paneHeaders.find((one) => /Claude Code Terminals/iu.test(one.title))
    ?? { title: null, box: null, items: [] };
  return {
    point: 2,
    scenario: 'S13',
    what: `the maximise button in the title of the list of terminals (header ${JSON.stringify(header.title)})`,
    ours: header.items.find((one) => MAXIMISE.test(one.label)) ?? null,
    anchors: header.items.filter((one) => !isOurs(one.label)),
    wanted: null,
  };
}

/**
 * S26, after a terminal has been restarted: does the tab of a terminal tell the
 * same story as its own row.
 *
 * The plan is exact that the defect is not in the table of state to colour --
 * that table is checked whole and elsewhere -- but in which tab a record walks
 * behind once the terminals under it have changed. So the ROW is the anchor and
 * the colour it is drawn in is what the TAB is held to: the row is the product's
 * own belief, rendered by the editor, and a tab that disagrees with it is a badge
 * that stuck.
 *
 * When the row was not drawn at all -- Cursor's side bar has no layout on a
 * fresh profile, measured 2026-08-25 -- the anchor is undrawn and the judge
 * refuses, which is the honest answer: nothing was seen, so nothing is known.
 */
function s26TabsAgreeWithRows(seen, terminals, from) {
  return terminals.map((name, nth) => {
    const row = seen.rows.find((one) => one.label === name) ?? null;
    const tab = seen.tabs.find((one) => one.label === name) ?? null;
    return {
      point: from + nth,
      scenario: 'S26',
      what: `the tab of ${JSON.stringify(name)} against its own row, after a terminal was restarted`,
      ours: tab,
      // The row, as the editor drew it. It is the anchor AND the source of what
      // the tab is held to, which is why an unseen row can only ever refuse.
      anchors: row === null ? [] : [row],
      anchorsAre: 'the row the product drew in the list',
      wanted: row === null || !row.visible || row.box.w === 0
        ? null
        : { codicon: null, color: row.color, because: `the row for ${name} is drawn in ${String(row.color)}` },
    };
  });
}

/** The editor's own notification bell, which is drawn whether or not anything was raised. */
function theBell(seen) {
  return seen.statusBar.filter((one) => /notification/iu.test(one.label));
}

/** The tab a person would say is in front: the active one of the active group. */
function tabInFront(seen) {
  return seen.tabs.find((one) => one.active && one.inActiveGroup)
    ?? seen.tabs.find((one) => one.active)
    ?? null;
}

/**
 * S25, first half: the agent asked for permission, and the product said so
 * where somebody in another window would see it.
 *
 * **The anchor is a notification the STAND-IN raised in the same second**, and
 * it took a red in Cursor to learn why it has to be. The first version anchored
 * on the editor's own notification bell in the status bar -- always drawn,
 * toast or no toast -- and in Cursor 3.17.19 that produced "NOT DRAWN, beside
 * Notifications, which the editor drew". But a bell in the status bar proves the
 * STATUS BAR was seen; it says nothing about whether a toast, had there been
 * one, is where these eyes look. The fork restyles what it pleases. So the
 * anchor is a toast that certainly exists: one raised through the same one API
 * by the observer, a moment after the product's. Ours missing beside it is the
 * product; both missing is a window whose notifications the eyes cannot read,
 * and that is REFUSED.
 *
 * A request that never reached the product names no anchor at all: whatever is
 * or is not on the screen then, it is not the product's answer to a question
 * nobody asked it.
 */
function s25TheToastIsDrawn(seen, name, delivered, standIn, point) {
  const toast = seen.toasts.find((one) => one.message.includes(String(name))) ?? null;
  const theirs = standIn === undefined || standIn === null
    ? null
    : seen.toasts.find((one) => one.message.includes(String(standIn))) ?? null;
  return {
    point,
    scenario: 'S25',
    what: delivered.asked === true
      ? `a notification naming ${JSON.stringify(name)}, after its agent asked for permission`
      : `a notification for a permission request that never reached the product (${String(delivered.why)})`,
    ours: toast === null
      ? null
      : { label: toast.message, codicon: '', box: toast.box, visible: toast.visible, color: null },
    anchors: delivered.asked !== true
      ? []
      : [theirs === null
        ? { label: 'the stand-in raised a notification of its own and the eyes did not find it either', codicon: '', box: { x: 0, y: 0, w: 0, h: 0 }, visible: false, color: null }
        : { label: 'a notification of the stand-in\'s own, raised a moment later', codicon: '', box: theirs.box, visible: theirs.visible, color: null }],
    anchorsAre: 'a notification the stand-in raised through the same API, beside the editor\'s own bell '
      + (theBell(seen).map((one) => `${one.label} (${one.codicon})`).join(', ') || 'which is not drawn either'),
    wanted: null,
  };
}

/**
 * S25, second half: the click leads to the terminal it was raised about.
 *
 * The scenario's own sentence -- "клик по ней ведёт к нужному терминалу" -- and
 * the word that carries it is НУЖНОМУ. A button that brings up a terminal, any
 * terminal, is not what was asked for, so what is judged is the NAME of the tab
 * in front and not merely that a tab is.
 */
function s25TheClickLeadsThere(seen, name, point, landed) {
  const front = tabInFront(seen);
  return {
    point,
    scenario: 'S25',
    what: `the tab in front, after the notification about ${JSON.stringify(name)} was clicked`,
    ours: front,
    /*
     * The anchor of THIS sighting is not a control: it is the evidence that a
     * press lands in this window at all.
     *
     * Without it a red here has two causes and no way to tell them apart -- the
     * product's button did nothing, or the eyes cannot press a button -- and the
     * second dressed as the first is exactly the mistake this apparatus was
     * built to stop. So a press of the EDITOR'S OWN control on the very same
     * toast is made when ours changes nothing, and what it answered stands here
     * as the anchor.
     */
    anchors: [landed],
    anchorsAre: 'a press that landed -- a control that answered one, on the same toast',
    wanted: { codicon: null, color: null, label: String(name), because: `the notification was raised about ${String(name)}` },
  };
}

/**
 * Clicks where a person would click, and gives the workbench a moment to act.
 *
 * The pointer is moved first and the press is spaced out from it, because a
 * workbench draws hovers and moves things under a pointer that has just
 * arrived: a press in the same millisecond as the move can land on a layout
 * that no longer holds.
 */
async function press(cdp, at) {
  const x = Math.round(at.x + at.w / 2);
  const y = Math.round(at.y + at.h / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await new Promise((wake) => setTimeout(wake, 300));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await new Promise((wake) => setTimeout(wake, 80));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  await new Promise((wake) => setTimeout(wake, 1500));
  return { x, y };
}

/** Escape, the way a person closes a menu they did not mean to open. */
async function escape(cdp) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await new Promise((wake) => setTimeout(wake, 500));
}

/** Whether a toast naming this terminal is still on the screen. */
function toastFor(seen, name) {
  return seen.toasts.find((one) => one.message.includes(String(name))) ?? null;
}

/**
 * Looks until the thing about to be pressed has stopped moving.
 *
 * By the state of the picture and not by a sleep, for the reason `agreeing()`
 * gives: a press aimed at a box read during a reflow lands on whatever has since
 * slid into that place, and the failure it produces looks exactly like a button
 * that does nothing. The layout override is lifted just before this is called,
 * which is precisely a reflow.
 */
async function settled(cdp, where) {
  let seen = await look(cdp);
  let last = JSON.stringify(where(seen));
  for (let tries = 0; tries < 8; tries += 1) {
    await new Promise((wake) => setTimeout(wake, 600));
    const again = await look(cdp);
    const now = JSON.stringify(where(again));
    seen = again;
    if (now === last) {
      return seen;
    }
    last = now;
  }
  return seen;
}


// --- getting ready ----------------------------------------------------------

function theEditor() {
  const named = process.env.GRIPTERM_EYES_EDITOR;
  if (named !== undefined && named.length > 0) {
    if (!existsSync(named)) {
      throw new Error(`GRIPTERM_EYES_EDITOR names ${named}, and there is nothing there`);
    }
    return named;
  }
  const found = EDITORS.find((one) => existsSync(one));
  if (found === undefined) {
    throw new Error(
      `no editor for the eyes to look at: none of ${EDITORS.join(', ')} exists. ` +
        'Set GRIPTERM_EYES_EDITOR to the .exe of the one to use.'
    );
  }
  return found;
}

/**
 * The directories, and the one refusal that stands in front of the whole run.
 *
 * The store is emptied every run: a run that inherited yesterday's records would
 * be pairing rows with tabs that belong to terminals nobody made today, which is
 * the very confusion S26 is about.
 */
function prepare() {
  const store = resolve(STORE);
  if (!store.startsWith(resolve(BASE))) {
    throw new Error(
      `this run would have pointed the product at ${store}, which is not under ${BASE}. ` +
        'The store the eyes open is the store they may write in, and that is not one of ours.'
    );
  }

  rmSync(join(BASE, `user-data-${LABEL}`), { recursive: true, force: true });
  rmSync(STORE, { recursive: true, force: true });
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(EXTENSIONS, { recursive: true });
  mkdirSync(PROJECT, { recursive: true });

  for (const [name, body] of [
    ['README.md', '# the project the eyes look at\n\nSo that the window has something in it that is not ours.\n'],
  ]) {
    const file = join(PROJECT, name);
    if (!existsSync(file)) {
      writeFileSync(file, body, 'utf8');
    }
  }

  return hostUserData(LABEL, {
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
  });
}

/** Waits for a scene the observer hands over, and says out loud when it has it. */
async function scene(name) {
  const file = `${SCENES}-${name}.json`;
  const handed = await until(
    `the observer to hand over scene ${name}`,
    () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    SCENE_WITHIN_MS
  );
  if (handed.error !== null && handed.error !== undefined) {
    throw new Error(`the observer could not build scene ${name}: ${String(handed.error)}`);
  }
  return handed;
}

/** Tells the observer the eyes are done with a scene and it may disturb the window again. */
function looked(name) {
  writeFileSync(`${SCENES}-${name}.looked`, 'looked\n', 'utf8');
}

/**
 * Puts the pointer over a pane header.
 *
 * Not a flourish: VS Code keeps a pane's title actions under `display: none`
 * until the pane is hovered or focused, so a look taken without this reports
 * every button in that header missing -- ours and the editor's own alike. The
 * anchor would catch it, but it would catch it as a refusal on every run, which
 * is a check that never says anything.
 */
async function hover(cdp, at) {
  if (at === null || at.w === 0 || at.h === 0) {
    return;
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(at.x + at.w / 2),
    y: Math.round(at.y + at.h / 2),
    buttons: 0,
  });
  await new Promise((wake) => setTimeout(wake, 800));
}

/**
 * How tall the group holding a run's terminals is, against the whole editor
 * area, in the pixels the workbench laid out.
 *
 * The measure of the customer's own sentence. `share` is what fraction of the
 * editor area's height the terminals have: a strip at rest holds a part of it,
 * and maximised it holds the lot.
 */
function theStrip(seen, terminals) {
  const groups = seen.editorGroups.filter((one) => one.box.h > 0);
  const ours = groups.find((one) => one.tabs.some((tab) => terminals.includes(tab))) ?? null;
  const top = Math.min(...groups.map((one) => one.box.y));
  const bottom = Math.max(...groups.map((one) => one.box.y + one.box.h));
  const area = bottom - top;
  return {
    groups: groups.length,
    height: ours === null ? 0 : ours.box.h,
    area,
    share: ours === null || area === 0 ? 0 : Math.round((ours.box.h / area) * 100) / 100,
  };
}

/**
 * Looks again until what is drawn agrees with what the product believes, or the
 * ceiling passes.
 *
 * By the state of the picture, never by a sleep: "wait 800 ms and hope" is how a
 * measurement becomes a coin toss, and this one has already been caught being
 * one. The wait it actually needed is returned with the sightings, so that a
 * green says how nearly it was a red.
 */
async function agreeing(cdp, make) {
  const started = Date.now();
  const reds = (sightings) => judge({ build: null, laidOutAt: LAYOUT, onboardingOverlaysCleared: 0, sightings }).red;
  let sightings = make(await look(cdp));
  while (reds(sightings) > 0 && Date.now() - started < AGREES_WITHIN_MS) {
    await new Promise((wake) => setTimeout(wake, POLL_MS));
    sightings = make(await look(cdp));
  }
  const waited = Date.now() - started;
  const settled = reds(sightings) === 0;
  return {
    waited,
    settled,
    /*
     * The number goes into the sentence the verdict prints, because "they
     * disagreed" and "they disagreed for fifteen seconds" are different facts.
     *
     * Worded so that it stays true of a REFUSED sighting too. It said "which
     * they did after 4 ms" at first, and on a refusal that reads as agreement
     * observed when nothing was observed at all -- the ceiling had simply not
     * been reached, because a refusal is not a red. How long the eyes watched is
     * a fact about every sighting; whether anything agreed is not.
     */
    sightings: sightings.map((one) => ({
      ...one,
      what: `${one.what}, watched for ${String(waited)} ms`,
    })),
  };
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data;
  if (typeof data !== 'string') {
    say(`  (no screenshot: ${JSON.stringify(shot).slice(0, 200)})`);
    return;
  }
  const file = join(OUTPUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  say(`  a picture of what was looked at: ${file}`);
}

// --- the run ----------------------------------------------------------------

async function main() {
  const editor = theEditor();
  const build = forkBuild(editor);
  const userData = prepare();
  const port = await freePort();

  step(`the eyes, in ${build.editor} ${build.version} (commit ${String(build.commit).slice(0, 8)}, built ${String(build.built).slice(0, 10)})`);
  say(`  ${editor}`);
  say(`  a debugging endpoint on 127.0.0.1:${String(port)}, and the store at ${STORE}`);

  const before = editorWindows();
  say(`  windows that must survive : ${before.join(', ') || 'none'}`);

  const window = spawn(
    editor,
    [
      `--extensionDevelopmentPath=${PRODUCT}`,
      `--extensionDevelopmentPath=${OBSERVER}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${EXTENSIONS}`,
      `--remote-debugging-port=${String(port)}`,
      '--disable-workspace-trust',
      '--new-window',
      PROJECT,
    ],
    {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, GRIPTERM_EYES_SCENES: SCENES, GRIPTERM_EYES_MAKE: String(TERMINALS) },
    }
  );
  window.unref();

  let sightings = [];
  let cleared = 0;
  let cdp = null;
  /** What the strip measured before the button was pressed, after one press and after two. */
  let presses = [];
  try {
    await until('the debugging endpoint to answer', () => endpoint(`http://127.0.0.1:${String(port)}/json/version`), UP_WITHIN_MS);
    const targets = await until(
      'the workbench to be among the debugging targets',
      async () => {
        const list = await endpoint(`http://127.0.0.1:${String(port)}/json/list`);
        return list === null ? null : (list.find((one) => one.type === 'page' && /workbench/u.test(String(one.url))) ?? null);
      },
      UP_WITHIN_MS
    );
    cdp = session(targets.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: LAYOUT.width, height: LAYOUT.height, deviceScaleFactor: 1, mobile: false,
    });
    const viewport = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ w: innerWidth, h: innerHeight })', returnByValue: true,
    });
    say(`  attached to the workbench, laid out at ${String(viewport?.result?.result?.value)}`);

    // Scene one is only ever used to get the first-run sheet out of the way.
    await scene('one');
    const first = await look(cdp);
    if (first.onboardingOverlays > 0) {
      const removed = await cdp.send('Runtime.evaluate', {
        expression:
          '(() => { const o = [...document.querySelectorAll(\'.onboarding-v2-overlay\')];' +
          ' o.forEach((e) => { e.remove(); }); return o.length; })()',
        returnByValue: true,
      });
      cleared = Number(removed?.result?.result?.value ?? 0);
      say(`  the editor's own first-run sheet was over the whole window; ${String(cleared)} of them removed`);
      /*
       * The sheet was in front while the workbench laid itself out, so the
       * layout underneath it could be one taken in its shadow. The window is
       * resized and put back -- what a person does by dragging a corner -- so
       * that whatever is measured next is a layout taken in the open.
       *
       * MEASURED 2026-08-25: this changes no answer. Cursor's side bar is
       * `display: none` before the nudge and after it, so the fork is not
       * holding a stale layout -- it is not laying that part out at all. The
       * nudge stays anyway, and it earns its 1.4 seconds by removing that
       * explanation rather than by fixing anything: without it, every refusal
       * of a side-bar sighting could be answered with "you measured too early".
       */
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: LAYOUT.width - 40, height: LAYOUT.height - 40, deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((wake) => setTimeout(wake, 700));
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: LAYOUT.width, height: LAYOUT.height, deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((wake) => setTimeout(wake, 700));
    }
    looked('one');

    const two = await scene('two');
    say(`  scene two: terminals ${two.terminals.join(', ')}; in front ${JSON.stringify(two.activeTab)}`);
    // The list's own header, hovered, because the workbench hides title actions
    // until then -- ours and its own alike.
    const before2 = await look(cdp);
    await hover(cdp, before2.paneHeaders.find((one) => /Claude Code Terminals/iu.test(one.title))?.box ?? null);
    const seen2 = await look(cdp);
    sightings = [s13InTheEditorTitle(seen2, two.terminals), s13InTheViewTitle(seen2)];
    await screenshot(cdp, 'scene-two');
    say(`  anything anywhere in the window by the names this run looks for: ${
      seen2.anywhere.length === 0 ? 'none' : seen2.anywhere.map((one) => `${one.label} ${String(one.box.w)}x${String(one.box.h)} visible=${String(one.visible)}`).join(' | ')}`);
    say(`  the parts of the window: ${seen2.parts.map((one) => `${one.selector} ${one.display} ${String(one.box.w)}x${String(one.box.h)}`).join(' | ')}`);
    const strip = seen2.editorActionBars.find((one) => one.activeTab !== null && two.terminals.includes(one.activeTab));
    say(`  the bar in the terminal's own title holds: ${
      (strip?.items ?? []).map((one) => `${one.label} ${String(one.box.w)}x${String(one.box.h)}`).join(' | ') || 'nothing'}`);
    looked('two');

    const three = await scene('three');
    say(`  scene three: ${JSON.stringify(three.closedName)} was closed and a new one made; now ${three.terminals.join(', ')}`);
    const agreed = await agreeing(cdp, (seen) => s26TabsAgreeWithRows(seen, three.terminals, 3));
    say(`  the badges ${agreed.settled ? 'agreed with the records' : 'STILL disagreed with the records'} after ${String(agreed.waited)} ms`);
    sightings = [...sightings, ...agreed.sightings];
    await screenshot(cdp, 'scene-three');
    looked('three');

    /*
     * The button PRESSED, and both ways, in whichever editor this is.
     *
     * Printed and recorded rather than judged. What the gate holds this editor
     * to is that the button is DRAWN -- the defect the customer reported three
     * times -- and what the toggle does is held by the live suites, which can
     * ask `vscode.getEditorLayout` for the sizes instead of reading them off
     * the screen. This is the third thing neither of those covers: the same
     * two presses in the fork, measured where a person would look.
     */
    const pressed = [];
    for (const [name, what] of [['four', 'before it was pressed'], ['five', 'after one press'], ['six', 'after a second press']]) {
      const handed = await scene(name);
      const strip = theStrip(await look(cdp), handed.terminals);
      pressed.push({ name, what, ...strip, activeTab: handed.activeTab });
      say(`  the strip ${what}: ${String(strip.height)} px of the ${String(strip.area)} px editor area`
        + ` (${String(strip.share)} of it), across ${String(strip.groups)} group(s), with ${JSON.stringify(handed.activeTab)} in front`);
      await screenshot(cdp, `scene-${name}`);
      looked(name);
    }
    presses = pressed;

    /*
     * S25, both halves, and the first time either has been looked at.
     *
     * The scene is the customer's: an agent asks for permission while the
     * person is looking at something else. The observer puts a FILE in front
     * and posts the CLI's own `PermissionRequest` hook to the product's own
     * loopback endpoint -- the very channel a real agent uses, with the token
     * and session id that terminal was launched with -- so everything after it
     * is the product's doing and nothing of ours.
     */
    const seven = await scene('seven');
    say(`  scene seven: permission asked for ${JSON.stringify(seven.askedFor)}: ${JSON.stringify(seven.permission)}`);
    say(`  in front when it was asked: ${JSON.stringify(seven.activeTab)}`);
    const raised = await look(cdp);
    say(`  the window's toasts: ${raised.toasts.length === 0 ? 'none' : raised.toasts.map((one) => `${JSON.stringify(one.message)} ${String(one.box.w)}x${String(one.box.h)} [${one.buttons.map((b) => b.label).join(', ')}]`).join(' | ')}`);
    say(`  the notification bell says: ${theBell(raised).map((one) => `${one.label} (${one.codicon}) ${String(one.box.w)}x${String(one.box.h)}`).join(', ') || 'nothing of the kind is drawn'}`);
    sightings = [...sightings, s25TheToastIsDrawn(raised, seven.askedFor, seven.permission, seven.standIn, 5)];
    await screenshot(cdp, 'scene-seven');

    /*
     * The click, and the ONE thing about it that had to be measured before it
     * could be believed.
     *
     * A press is dispatched in the window's REAL pixels, and the layout
     * override is lifted for it. Measured 2026-08-26, and it cost two runs: with
     * the workbench laid out at 1920x1200 over a window the desktop had made
     * 1440x900, every press this driver sent landed outside the window and
     * NOTHING answered it -- not our button and not the editor's own on the same
     * toast. The same button pressed with the override lifted, at 1328,830
     * instead of 1808,1130, closed the notification and brought the terminal up.
     * So the boxes are read again in the real layout, the press is made there,
     * and the override goes back on afterwards for whatever is looked at next.
     *
     * AND THE FIRST PRESS IS SPENT. Measured over four runs the same day: the
     * first press this driver dispatches into the window changes nothing and the
     * second answers -- with `Page.bringToFront` in front of it and without, so
     * that is not what it is. It is a fact about this driver and not about the
     * product, and the way it is kept honest is that the eyes press again ONCE,
     * say how many presses it took, and hold a button that answers neither press
     * to the control below rather than to an accusation.
     */
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const real = await settled(cdp, (seen) => toastFor(seen, seven.askedFor)?.buttons[0]?.box ?? null);
    const toast = toastFor(real, seven.askedFor);
    const button = toast?.buttons.find((one) => one.box.w > 0) ?? null;
    if (button === null) {
      say('  no button to press on it, so where the click leads cannot be asked');
      sightings = [...sightings, {
        point: 6,
        scenario: 'S25',
        what: `the tab in front, after a notification about ${JSON.stringify(seven.askedFor)} that offered nothing to press`,
        ours: null,
        anchors: [],
        anchorsAre: 'a button on the notification, of which there was none',
        wanted: null,
      }];
    } else {
      say(`  pressing ${JSON.stringify(button.label)} on it, ${String(button.box.w)}x${String(button.box.h)} at ${String(button.box.x)},${String(button.box.y)}, in the window's real layout`);
      let at = await press(cdp, button.box);
      let after = await look(cdp);
      let presses = 1;
      if (toastFor(after, seven.askedFor) !== null) {
        // Pressed again, once, and the number is printed rather than hidden: a
        // button that needs two presses from this driver and one from a person
        // is a fact about the driver, and a button that answers neither is a
        // fact about the product. They must not be told apart by guesswork.
        say('  it did not answer, so the same button is pressed once more');
        at = await press(cdp, button.box);
        after = await look(cdp);
        presses = 2;
      }
      const answered = toastFor(after, seven.askedFor) === null;
      say(`  after ${String(presses)} press(es): the tab in front is ${JSON.stringify(tabInFront(after)?.label ?? null)}`
        + `, and the notification is ${answered ? 'GONE' : 'still on the screen'}`);

      /*
       * The control for the press itself, made only when ours changed nothing:
       * the editor's own control on the same toast, pressed the same way by the
       * same driver. A toast that closes for it and not for ours is the
       * product's answer; a toast that closes for neither is a press that never
       * landed, and the eyes must say so rather than call it a defect.
       */
      let landed = {
        label: `the notification closed when ${JSON.stringify(button.label)} was pressed at ${String(at.x)},${String(at.y)}`
          + `${presses === 1 ? '' : `, on press ${String(presses)}`}`,
        codicon: '', box: { x: at.x, y: at.y, w: 1, h: 1 }, visible: true, color: null,
      };
      if (!answered) {
        const own = toast?.ownControls.find((one) => one.box.w > 0) ?? null;
        if (own === null) {
          landed = { label: 'the toast carried no control of the editor own to press instead', codicon: '', box: { x: 0, y: 0, w: 0, h: 0 }, visible: false, color: null };
        } else {
          say(`  ours changed nothing, so pressing the editor's own ${JSON.stringify(own.label)} the same way`);
          await press(cdp, own.box);
          const control = await look(cdp);
          // Two ways a control can show a press reached it, and the second is
          // not optional: the one control a notification toast always carries is
          // `More Actions...`, which OPENS A MENU rather than closing anything.
          // Measured 2026-08-26 -- reading only "did the toast close" called a
          // press that plainly landed a press that never landed.
          const closed = toastFor(control, seven.askedFor) === null;
          const opened = control.menus > 0;
          const answeredControl = closed || opened;
          say(`  the editor's own control ${answeredControl
            ? `answered it (${closed ? 'the notification closed' : 'a menu opened'}) -- so a press does land in this window`
            : 'changed nothing either -- so no press lands in this window at all'}`);
          if (opened) {
            // Put the menu away again, so that whatever is looked at next is the
            // window and not our own leftovers.
            await escape(cdp);
          }
          landed = {
            label: `${own.label}, the editor's own on that toast, ${answeredControl ? 'answered the same press' : 'did not answer the same press'}`,
            codicon: own.codicon,
            box: answeredControl ? own.box : { x: 0, y: 0, w: 0, h: 0 },
            visible: answeredControl,
            color: null,
          };
        }
      }
      sightings = [...sightings, s25TheClickLeadsThere(after, seven.askedFor, 6, landed)];
      await screenshot(cdp, 'scene-eight');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: LAYOUT.width, height: LAYOUT.height, deviceScaleFactor: 1, mobile: false,
    });
    looked('seven');

    const eight = await scene('eight');
    // What the PRODUCT believes is in front, beside what the eyes saw. Printed
    // and not judged: the eyes judge the picture, and this is the other witness.
    say(`  the product's own account of it: active terminal ${JSON.stringify(eight.activeTerminal)}, active tab ${JSON.stringify(eight.activeTab)}`);
    looked('eight');
  } catch (failed) {
    // A driver that died is not a product that failed, and the difference must
    // survive into the file the gate reads. The sightings taken so far are kept
    // -- they were really seen -- and the reason is written beside them.
    say(`\n  THE EYES STOPPED: ${failed.message}`);
    writeFileSync(join(OUTPUT, 'stopped.txt'), `${failed.stack ?? failed.message}\n`, 'utf8');
  } finally {
    if (cdp !== null) {
      cdp.close();
    }
    const mine = editorWindows().filter((pid) => !before.includes(pid));
    say(`\n=== closing only : ${mine.join(', ') || 'none'}`);
    for (const pid of mine) {
      closeWindow(pid);
    }
    try {
      await until(
        `the ${String(mine.length)} window(s) this run opened to be gone`,
        () => (editorWindows().filter((pid) => mine.includes(pid)).length === 0 ? true : null),
        CLOSES_WITHIN_MS
      );
      say('  they are gone');
    } catch (failed) {
      say(`  WARNING: ${failed.message}. A window of this run is still open and is not the owner's.`);
    }
  }

  const recording = { build, laidOutAt: LAYOUT, onboardingOverlaysCleared: cleared, sightings, presses };
  writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');

  const verdict = judge(recording);
  writeFileSync(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');

  step('what the eyes saw');
  for (const finding of verdict.findings) {
    say(`  ${String(finding.point)}. ${finding.answer.toUpperCase().padEnd(8)} ${finding.scenario}  ${finding.says}`);
  }
  say('');
  say(`  ${String(verdict.green)} green, ${String(verdict.red)} red, ${String(verdict.refused)} refused`);
  say(`  the recording is at ${RECORDING}`);
  say(`  the verdict is at   ${VERDICT}`);

  // Non-zero on red, so that a person running this by hand gets an answer. The
  // gate does NOT read this: it reads the verdict, because a driver that died
  // before it looked also exits non-zero and those two are not the same fact.
  process.exitCode = verdict.red > 0 ? 1 : 0;
}

await main();
