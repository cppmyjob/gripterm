import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HumanMetadata,
  LaunchRecipe,
  ObservedState,
  SessionId,
  TerminalEntry,
  TerminalId,
  ownerRefFor,
  type OwnerIdentity,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';
import type { DetailsReport, ViewReport } from '../../packages/webview/src/protocol';

/**
 * The details half of the panel: the record, and the history it comes from.
 *
 * **Both ends produce every measurement, and neither is a screenshot.** The host
 * knows what it believes the half says and how many times it has read the
 * journal off the disk; the page reports what it really DREW -- text read back
 * off its own elements, and the glyph the icon font really put beside the
 * heading. A suite reading only the host's side would be asserting that the host
 * agrees with itself.
 *
 * What is measured here, and what each measurement would otherwise be:
 *
 *   * the half is about the terminal on screen -> the page's own answer, so a
 *     half describing the first terminal the panel holds is caught;
 *   * a record's change arrives -> the task on screen after the command that
 *     writes it, with nothing reopened;
 *   * it does not poll -> the number of draws and the number of reads, taken
 *     twice with a second and a half of nothing in between. Nothing else tells a
 *     half that follows a signal from one that asks on a timer;
 *   * the history is the JOURNAL's -> an event delivered the way an agent
 *     delivers one, over the loopback endpoint with the token this window
 *     issued. Only that path writes the file, and a half drawing its history
 *     from the registry instead would show nothing at all;
 *   * a half with nothing to say says so -> the sentence in it when the record
 *     of the terminal on screen goes away, because a blank rectangle is the one
 *     thing this half may never be. The empty PANEL is the rule's business and
 *     is checked there: in a gate that runs every suite in one window, the tabs
 *     other suites ended keep their place until somebody closes them (M3.9).
 */

const SETTLES_WITHIN_MS = 30_000;
const LOOK_EVERY_MS = 25;

/** Long enough that a half redrawing on any plausible timer would have redrawn. */
const IDLE_MS = 1500;

/** How many times the half is redrawn under a keyboard that is in the terminal. */
const REDRAWS = 20;
const REDRAW_EVERY_MS = 25;

const TERMINAL_UUID = '550e8400-e29b-41d4-a716-446655441111';
const SESSION_UUID = 'c7d8e9f0-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const NAME = 'a terminal with a history';
const TASK = 'Check the details half';

/** Quiet on purpose: this suite counts draws, and a chatty process is a redraw. */
const STAND = `
process.stdout.write('READY' + String.fromCharCode(10));
setInterval(() => { /* stay alive with nothing to say */ }, 60000);
`;

type Gateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];

class CollectedLog {
  public readonly lines: string[] = [];

  public info(message: string): void {
    this.lines.push(`info: ${message}`);
  }

  public warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  public error(message: string): void {
    this.lines.push(`error: ${message}`);
  }
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function extensionPath(): string {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return extension.extensionPath;
}

function nodePath(): string {
  const found = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/u)[0];
  return found === undefined ? 'node' : found.trim();
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function until(what: string, answer: () => boolean): Promise<void> {
  const started = Date.now();
  while (!answer()) {
    if (Date.now() - started > SETTLES_WITHIN_MS) {
      throw new Error(`waited ${String(SETTLES_WITHIN_MS)} ms for ${what}`);
    }
    await delay(LOOK_EVERY_MS);
  }
}

/** The half as the PAGE has it: the only side that knows what was drawn. */
async function drawn(because: string): Promise<DetailsReport> {
  const { workbench } = await api();
  const report: ViewReport = await workbench.measure(because, SETTLES_WITHIN_MS);
  return report.details;
}

/** The half, once the page has drawn what was asked of it -- or a failure that shows what it drew. */
async function drawnUntil(
  what: string,
  answer: (page: DetailsReport) => boolean
): Promise<DetailsReport> {
  const started = Date.now();
  let page = await drawn(`the suite is waiting for ${what}`);
  while (!answer(page)) {
    if (Date.now() - started > SETTLES_WITHIN_MS) {
      throw new Error(`waited ${String(SETTLES_WITHIN_MS)} ms for ${what}; the half drew ${JSON.stringify(page)}`);
    }
    await delay(LOOK_EVERY_MS);
    page = await drawn(`the suite is waiting for ${what}`);
  }
  return page;
}

/**
 * Takes this suite's terminal out of the store, journal and all.
 *
 * The journal is a FILE, and files outlive a run: without this the second run of
 * the day starts with the first run's events already drawn, and "the event
 * arrived" is true before anything is delivered. Both gates run this suite, so
 * it would have been true and meaningless in one of them.
 */
async function forgetOnDisk(): Promise<void> {
  const { readiness } = await api();
  await rm(join(readiness.storageDir, 'terminals', TERMINAL_UUID), {
    recursive: true,
    force: true,
  }).catch(() => null);
}

/** Everything the half SAYS, with the count of drawings left out of it. */
function said(page: DetailsReport): string {
  return JSON.stringify({ ...page, draws: 0 });
}

/** The record the half describes. Registered, because the half is drawn from the registry. */
function recordFor(identity: OwnerIdentity): TerminalEntry {
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(TERMINAL_UUID),
    sessionId: SessionId.fromString(SESSION_UUID),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: NAME,
      task: null,
      notes: [],
      tags: [],
      color: null,
    }),
    launch: LaunchRecipe.create({
      cwd: process.cwd(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    }),
    observed: ObservedState.create({
      state: 'idle',
      lastEventAt: new Date(),
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt: new Date(),
  });
}

/**
 * Delivers one hook event the way an agent does.
 *
 * Over the loopback endpoint with this activation's token, because that is the
 * only path that writes the journal -- and the history in the panel comes from
 * the journal. A suite that called the registry directly would leave the file
 * empty and still see the record change, which is exactly the confusion this
 * measurement exists to prevent.
 */
async function deliver(body: Record<string, unknown>): Promise<void> {
  const { readiness, hookToken } = await api();
  assert.ok(readiness.address, 'this window took no port for hook events');
  const answer = await fetch(`${readiness.address.origin}/ev/${TERMINAL_UUID}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(answer.status, 202, 'the hook endpoint refused an event this suite sent');
}

suite('the details half of the panel', () => {
  let handle: Handle | null = null;
  let gateway: Gateway | null = null;
  let directory: string | null = null;

  suiteSetup(async () => {
    const { makeGateway, stage, registry, identity, workbench } = await api();

    await forgetOnDisk();
    registry.register(recordFor(identity));
    directory = await mkdtemp(join(os.tmpdir(), 'gripterm-details-'));
    const script = join(directory, 'stand.js');
    await writeFile(script, STAND, 'utf8');

    gateway = makeGateway({
      setting: 'own',
      mode: 'process',
      location: 'editor',
      extensionPath: extensionPath(),
      editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
      logger: new CollectedLog(),
      audience: stage,
    });
    handle = await gateway.create({
      terminalId: { value: TERMINAL_UUID } as unknown as Spec['terminalId'],
      name: NAME,
      // Not the script's own directory: Windows locks a running process's
      // working directory and a kill is asynchronous (O4).
      cwd: os.tmpdir(),
      env: {},
      shellPath: nodePath(),
      shellArgs: [script],
    });

    /*
     * The terminal says it has started, exactly as a real one does.
     *
     * Not decoration: a record nobody has heard from for twenty seconds is
     * announced as silent (`DEFAULT_SILENCE_MS`), and that announcement is a
     * warning in the corner of the window this gate runs in -- which took the
     * keyboard away from the suite that runs after this one (measured
     * 2026-08-18: its first three tests failed and the fourth recovered). A
     * fixture that never speaks is not a quieter terminal, it is a broken one.
     */
    await deliver({ hook_event_name: 'SessionStart', session_id: SESSION_UUID, source: 'startup' });

    await vscode.commands.executeCommand('gripterm.workbench.focus');
    await workbench.whenReady(SETTLES_WITHIN_MS);
    handle.show(false);
    await until('the page to show this suite\'s terminal', () => stage.attachedTerminal === TERMINAL_UUID);
  });

  suiteTeardown(async () => {
    const { stage, registry } = await api();
    // Taken off the strip by this suite, or the tab lives for the rest of the
    // run and turns up in somebody else's counts (M3.9).
    stage.removed(TERMINAL_UUID);
    gateway?.dispose();
    registry.forget(TerminalId.fromString(TERMINAL_UUID));
    await forgetOnDisk();
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true }).catch(() => null);
    }
  });

  test('describes the terminal on screen, in the words the tree uses', async () => {
    const { details, stage } = await api();

    await until(
      'the half to be about the terminal on screen',
      () => details.drawn?.headline?.terminalId === TERMINAL_UUID
    );
    const page = await drawnUntil('the terminal to be described', (half) => half.terminalId === TERMINAL_UUID);

    assert.equal(page.terminalId, stage.activeTerminal, 'the half is about a terminal other than the one on screen');
    assert.ok(page.headline.includes(NAME), `the heading says "${page.headline}"`);
    assert.equal(page.nothing, null, 'the half drew an empty state over a terminal it has');
    // The icon really drew: a `ThemeIcon` id carried across literally matches no
    // rule and leaves a blank space, which no assertion about text would see.
    assert.notEqual(page.glyph, 'none', 'the state icon drew nothing at all');
    assert.ok(
      page.facts.some((fact) => fact.startsWith('folder: ')),
      `the facts drawn were ${JSON.stringify(page.facts)}`
    );
    assert.ok(
      page.facts.some((fact) => fact.startsWith('session: ')),
      `the facts drawn were ${JSON.stringify(page.facts)}`
    );
  });

  test('a change to the record arrives by itself, with nothing reopened', async () => {
    const { metadata } = await api();
    const before = (await drawn('the suite is about to write a task')).draws;

    metadata.setTask(TerminalId.fromString(TERMINAL_UUID), TASK);

    const page = await drawnUntil('the task to reach the half', (half) => half.task === TASK);
    assert.ok(page.draws > before, 'the half was never redrawn');
  });

  /*
   * The promise is "no clock", and the honest way to measure it is not "the
   * number never moves": a window sweeps the records of other windows on a timer
   * of its own, and a record it touches is a change this half is right to draw.
   * What is asserted is the implication -- a redraw happened ONLY IF what is on
   * screen is different -- which is exactly what a half asking on a timer fails.
   */
  test('redraws only when what it says has changed', async () => {
    const { details } = await api();
    const before = await drawn('the suite is about to wait and watch');
    const readsBefore = details.reads;

    await delay(IDLE_MS);

    const after = await drawn('the suite has waited with nothing happening');
    assert.ok(
      after.draws === before.draws || said(after) !== said(before),
      `the half redrew itself ${String(after.draws - before.draws)} times without changing a word: ${said(after)}`
    );
    assert.ok(
      details.reads === readsBefore || said(after) !== said(before),
      `the half read the journal ${String(details.reads - readsBefore)} times without changing a word ` +
      `(${String(details.lastRead)}): ${said(after)}`
    );
  });

  /*
   * The half is drawn in the same document as the terminal, and a person
   * switching agents redraws it while their hands are on the keyboard. A
   * rebuild that took the keyboard would be invisible in every other assertion
   * here -- and it would be the worst kind of defect this panel can have,
   * because the keystrokes would go somewhere else.
   *
   * Both ends answer: the page says where the keyboard is (`focusedHere`) and
   * the host says what it believes (`keyboard.focused`), so a lost focus and a
   * lost message are told apart.
   */
  test('redrawing the half does not take the keyboard out of the terminal', async () => {
    const { workbench, keyboard, metadata } = await api();
    const terminalId = TerminalId.fromString(TERMINAL_UUID);

    await until('the keyboard to be inside the terminal', () => {
      if (keyboard.focused) {
        return true;
      }
      workbench.focusHalf('terminal');
      return false;
    });

    for (let round = 0; round < REDRAWS; round += 1) {
      metadata.setTask(terminalId, `${TASK} ${String(round)}`);
      await delay(REDRAW_EVERY_MS);
    }

    await drawnUntil('the last task to be drawn', (half) => half.task === `${TASK} ${String(REDRAWS - 1)}`);
    const report = await workbench.measure('after twenty redraws under the keyboard', SETTLES_WITHIN_MS);
    assert.equal(report.focusedHere, true, 'the page lost the keyboard while redrawing the half');
    assert.equal(keyboard.focused, true, 'the window believes the keyboard left the terminal');
  });

  test('shows an event that arrived the way an agent sends one', async () => {
    const { details } = await api();
    const readsBefore = details.reads;

    await deliver({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_UUID,
      prompt: 'the text of a prompt, which the journal is not keeping',
    });

    const page = await drawnUntil('the event to be drawn', (half) => half.events.includes('you sent a prompt'));

    assert.ok(details.reads > readsBefore, 'the journal was never read again');
    // The default is that texts are NOT kept, so the half has to say so: a
    // history with the words missing and no explanation reads as a build that
    // lost them.
    assert.ok(
      page.notices.some((notice) => notice.includes('includeContent')),
      `the notices drawn were ${JSON.stringify(page.notices)}`
    );
  });

  /*
   * The empty state this suite can reach, and it is not the empty PANEL: the
   * gates run every suite in one window, and the terminals other suites have
   * ended keep their tabs until somebody closes them (M3.9). "The panel holds
   * nothing" is drawn by the rule and checked where the rule is.
   *
   * What is reachable here is the one a person meets: the record of the terminal
   * on screen goes away -- deleted, or held by a window this one cannot read --
   * and the half has words for it instead of a blank rectangle.
   */
  test('says why it has nothing to say, rather than going blank', async () => {
    const { registry, details } = await api();

    registry.forget(TerminalId.fromString(TERMINAL_UUID));

    const page = await drawnUntil(
      'the half to say the record is gone',
      (half) => half.notices.some((notice) => notice.includes('no record'))
    );
    assert.equal(page.terminalId, TERMINAL_UUID, 'the half stopped naming the terminal on screen');
    assert.deepEqual(page.facts, [], 'the half drew facts from a record that is not there');
    assert.equal(details.drawn?.headline?.terminalId, TERMINAL_UUID);
  });
});
