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

  const tabs = [...document.querySelectorAll('.tabs-container .tab')].map((tab) => {
    const icon = tab.querySelector('.tab-label [class*=codicon-], .monaco-icon-label[class*=codicon-], [class*=codicon-]:not(.tab-actions [class*=codicon-])');
    const name = tab.querySelector('.label-name');
    const close = tab.querySelector('.tab-actions .action-item');
    return { label: (name === null ? tab.textContent : name.textContent).trim(),
             codicon: icon === null ? '' : codicon(icon),
             box: box(tab), visible: tab.checkVisibility(),
             color: icon === null ? null : getComputedStyle(icon).color,
             close: close === null ? null : drawnOf(close) };
  });

  return JSON.stringify({
    onboardingOverlays: document.querySelectorAll('.onboarding-v2-overlay').length,
    editorActionBars, paneHeaders, rows, tabs,
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
      wanted: row === null || !row.visible || row.box.w === 0
        ? null
        : { codicon: null, color: row.color, because: `the row for ${name} is drawn in ${String(row.color)}` },
    };
  });
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
    looked('two');

    const three = await scene('three');
    say(`  scene three: ${JSON.stringify(three.closedName)} was closed and a new one made; now ${three.terminals.join(', ')}`);
    const agreed = await agreeing(cdp, (seen) => s26TabsAgreeWithRows(seen, three.terminals, 3));
    say(`  the badges ${agreed.settled ? 'agreed with the records' : 'STILL disagreed with the records'} after ${String(agreed.waited)} ms`);
    sightings = [...sightings, ...agreed.sightings];
    await screenshot(cdp, 'scene-three');
    looked('three');
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

  const recording = { build, laidOutAt: LAYOUT, onboardingOverlaysCleared: cleared, sightings };
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
