import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WRITE_DEBOUNCE_MS,
  HumanMetadata,
  LaunchRecipe,
  ObservedState,
  SessionId,
  TerminalEntry,
  TerminalId,
  ownerRefFor,
  type OwnerIdentity,
  type PersistedTerminalState,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';
import type { TabReport, ViewReport } from '../../packages/webview/src/protocol';

/**
 * The strip of tabs over our own terminal: switching, closing, and the mark of
 * an agent that is waiting.
 *
 * **Two ends produce every number here, and neither of them is a screenshot.**
 * The host knows which terminals it is holding, how many times each one's screen
 * has been drawn from its tail, and how big each pty was told to be. The page
 * reports what it DREW -- the glyph the icon font really put in each tab and the
 * colour the editor's own variable really resolved to. That second half is the
 * whole reason this suite can say anything about an icon at all: a `ThemeIcon`
 * id carried across literally (`sync~spin` as one CSS class) draws an empty
 * space, and an empty space is exactly what a passing test looks like from the
 * outside.
 *
 * What is measured, and what each measurement would otherwise be:
 *
 *   * the strip is what the panel holds -> two lists, one from each side;
 *   * the state is drawn -> the glyph, and a DIFFERENT glyph for a different
 *     state, so "it always draws the same icon" is caught;
 *   * switching loses nothing -> what the host posted while a terminal was
 *     hidden equals what its screen parsed;
 *   * switching redraws nothing -> the attach count, which is otherwise
 *     unfalsifiable: a screen redrawn from the tail looks exactly like the one
 *     that was already there;
 *   * a hidden terminal is already the right size -> its pty was resized while
 *     nobody was looking at it;
 *   * the cross ends a conversation -> `closedAt` on the record, which is the
 *     one irreversible act in this build (§I.3).
 */

const SETTLES_WITHIN_MS = 30_000;
const LOOK_EVERY_MS = 25;

/** How many times a pair of counts is retried before the stream is called restless. */
const COUNTING_ATTEMPTS = 10;

/** How far the border is dragged. Enough that the number of columns must change. */
const DRAG_PX = -80;

/** The record this suite registers, and the words on its tab. */
const SESSION_UUID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const TAB_NAME = 'a terminal this suite made';

/**
 * A process that says one word and answers what it is asked.
 *
 * Quiet on purpose: every count below is a difference between two reports, and a
 * process that printed on its own would put its own output inside those
 * differences. `READY` is not decoration -- node-pty holds every call to a pty
 * until its first data event (M3.7).
 */
const STAND = `
process.stdout.write('READY' + String.fromCharCode(10));
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', (chunk) => {
  for (const character of chunk) {
    if (character === '\\r' || character === '\\n') {
      if (line === 'ping') { process.stdout.write('PONG' + String.fromCharCode(10)); }
      if (line === 'bye') { process.exit(3); }
      line = '';
    } else {
      line += character;
    }
  }
});
setInterval(() => { /* stay alive with nothing to say */ }, 60000);
`;

type Gateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];
type Bridge = NonNullable<ReturnType<GriptermApi['stage']['bridgeFor']>>;

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

async function until(
  what: string,
  answer: () => boolean,
  withinMs = SETTLES_WITHIN_MS,
  everyMs = LOOK_EVERY_MS
): Promise<void> {
  const started = Date.now();
  while (!answer()) {
    if (Date.now() - started > withinMs) {
      throw new Error(`waited ${String(withinMs)} ms for ${what}`);
    }
    await delay(everyMs);
  }
}

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('gripterm.workbench.focus');
}

/** One terminal of ours, on the panel this window is really using. */
class Stand {
  public readonly handle: Handle;
  public readonly terminalId: string;
  public readonly said: readonly string[];
  private readonly _gateway: Gateway;
  private readonly _directory: string;

  private constructor(
    gateway: Gateway,
    handle: Handle,
    terminalId: string,
    directory: string,
    said: readonly string[]
  ) {
    this.said = said;
    this._gateway = gateway;
    this.handle = handle;
    this.terminalId = terminalId;
    this._directory = directory;
  }

  public static async start(suffix: string): Promise<Stand> {
    const directory = await mkdtemp(join(os.tmpdir(), 'gripterm-strip-'));
    const script = join(directory, 'stand.js');
    await writeFile(script, STAND, 'utf8');

    const { makeGateway, stage } = await api();
    const log = new CollectedLog();
    const gateway = makeGateway({
      setting: 'own',
      mode: 'process',
      location: 'editor',
      extensionPath: extensionPath(),
      editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
      logger: log,
      audience: stage,
    });
    // A whole uuid, unlike the stands of M3.7 and M3.8: this suite registers a
    // RECORD for its terminals, and a record's id is parsed rather than taken.
    const terminalId = `550e8400-e29b-41d4-a716-4466553900${suffix}`;
    const handle = await gateway.create({
      terminalId: { value: terminalId } as unknown as Spec['terminalId'],
      name: `strip ${suffix}`,
      // Not the script's own directory: Windows locks a running process's
      // working directory and `IPty.kill()` is asynchronous (O4).
      cwd: os.tmpdir(),
      env: {},
      shellPath: nodePath(),
      shellArgs: [script],
    });
    const stand = new Stand(gateway, handle, terminalId, directory, log.lines);
    const bridge = await bridgeOf(terminalId);
    await until(
      'the stand to announce itself',
      () => bridge.tail.text.includes('READY'),
      SETTLES_WITHIN_MS
    ).catch((cause: unknown) => {
      throw new Error(`${String(cause)} -- the gateway said: ${stand.said.join(' | ')}`);
    });
    return stand;
  }

  /** Says a word to this terminal's process, whether or not it is the one on screen. */
  public async say(word: string): Promise<void> {
    (await bridgeOf(this.terminalId)).type(`${word}\r`);
  }

  /** Takes this terminal off the strip and ends its process. */
  public async end(): Promise<void> {
    const { stage } = await api();
    stage.removed(this.terminalId);
    this._gateway.dispose();
    await rm(this._directory, { recursive: true, force: true }).catch(() => null);
  }
}

async function bridgeOf(terminalId: string): Promise<Bridge> {
  const { stage } = await api();
  const bridge = stage.bridgeFor(terminalId);
  assert.ok(bridge, `no bridge for ${terminalId}`);
  return bridge;
}

/** Brings a terminal to the screen and waits until the page says it is showing it. */
async function attach(stand: Stand): Promise<Bridge> {
  const { workbench, stage } = await api();
  await showPanel();
  await workbench.whenReady(SETTLES_WITHIN_MS);
  stand.handle.show(false);
  await until(
    `the page to show terminal ${stand.terminalId}`,
    () => stage.attachedTerminal === stand.terminalId,
    SETTLES_WITHIN_MS
  );
  return await bridgeOf(stand.terminalId);
}

/** Whether the strip the HOST holds calls this terminal by this name yet. */
function namedInStrip(strip: GriptermApi['strip'], terminalId: string, label: string): boolean {
  return strip.tabs.some((tab) => tab.terminalId === terminalId && tab.label === label);
}

/** The tab this report drew for a terminal, or a failure that says what it drew instead. */
function tabIn(report: ViewReport, terminalId: string): TabReport {
  const found = report.tabs.find((tab) => tab.terminalId === terminalId);
  assert.ok(
    found,
    `no tab for ${terminalId}; the strip drew ${JSON.stringify(report.tabs.map((tab) => tab.terminalId))}`
  );
  return found;
}

/**
 * The two counts of one moment: what the host has posted to a terminal's screen,
 * and what that screen has parsed.
 *
 * Taken while the stream is standing still and retried until it is -- a chunk
 * arriving between the two reads makes them disagree by exactly that chunk. The
 * terminal has to be the one on screen: `written` is the visible screen's count,
 * which is the only one a report carries.
 */
async function counted(
  bridge: Bridge,
  because: string
): Promise<{ readonly sent: number, readonly written: number }> {
  const { workbench } = await api();
  for (let attempt = 0; attempt < COUNTING_ATTEMPTS; attempt += 1) {
    await until('the page to write everything posted', () => bridge.unacknowledged === 0, SETTLES_WITHIN_MS);
    const sent = bridge.sentChars;
    const report = await workbench.measure(`${because} (${String(attempt)})`, SETTLES_WITHIN_MS);
    if (bridge.sentChars === sent) {
      return { sent, written: report.written };
    }
  }
  throw new Error(`the stream never stood still long enough to be counted: ${because}`);
}

/** Clicks a tab the way a person's mouse does, and waits for the switch to land. */
async function clickTab(terminalId: string): Promise<ViewReport> {
  const { workbench, stage } = await api();
  workbench.clickTab(terminalId);
  await until(
    `the panel to show ${terminalId} after its tab was clicked`,
    () => stage.attachedTerminal === terminalId,
    SETTLES_WITHIN_MS
  );
  return await workbench.measure('the suite is looking at the strip', SETTLES_WITHIN_MS);
}

/**
 * A record for a terminal this suite started, in a state of our choosing.
 *
 * Registered rather than invented on the host's side, because the strip is drawn
 * from the registry: what a tab is CALLED and what its icon means are the
 * record's answers, and a suite that supplied them another way would be testing
 * a path nothing uses.
 */
function recordFor(terminalId: string, state: PersistedTerminalState, identity: OwnerIdentity): TerminalEntry {
  const now = new Date();
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(terminalId),
    sessionId: SessionId.fromString(SESSION_UUID),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: TAB_NAME,
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
      state,
      lastEventAt: now,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt: now,
  });
}

/** Whatever a registered record left in the store on its way through. */
async function cleanUp(storageDir: string, terminalId: string): Promise<void> {
  await delay(DEFAULT_WRITE_DEBOUNCE_MS * 2);
  await rm(join(storageDir, 'terminals', terminalId), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, terminalId), { recursive: true, force: true });
    const inOwners = await readdir(join(trash, stamp, 'owners')).catch(() => ['keep']);
    if (inOwners.length === 0) {
      await rm(join(trash, stamp, 'owners'), { recursive: true, force: true });
    }
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

suite('the strip of tabs over our own terminal', () => {
  test('draws a tab for every terminal the panel holds, in the order it took them', async () => {
    const { workbench, strip } = await api();
    const first = await Stand.start('01');
    const second = await Stand.start('02');
    try {
      await attach(first);
      await attach(second);

      const report = await workbench.measure('the suite is counting the tabs', SETTLES_WITHIN_MS);

      // The host's belief and the page's own drawing, compared. One of them
      // alone would only say that the page agrees with itself.
      assert.deepEqual(
        report.tabs.map((tab) => tab.terminalId),
        strip.tabs.map((tab) => tab.terminalId),
        'the strip the page drew is not the strip the host asked for'
      );
      const order = report.tabs.map((tab) => tab.terminalId);
      assert.ok(
        order.includes(first.terminalId) && order.indexOf(first.terminalId) < order.indexOf(second.terminalId),
        `the tabs are not in the order the panel took them: ${JSON.stringify(order)}`
      );
      // Exactly one tab is the one on screen, and it is the one the stage says.
      assert.deepEqual(
        report.tabs.filter((tab) => tab.active).map((tab) => tab.terminalId),
        [second.terminalId]
      );
      assert.equal(report.attached, second.terminalId);
    } finally {
      await second.end();
      await first.end();
    }
  });

  test('draws the state with the icon font, and a different state differently', async () => {
    const { workbench, registry, identity, readiness, strip } = await api();
    const stand = await Stand.start('03');
    const working = recordFor(stand.terminalId, 'working', identity);
    try {
      await attach(stand);
      registry.register(working);
      await until(
        'the tab to take the name from the record',
        () => namedInStrip(strip, stand.terminalId, TAB_NAME),
        SETTLES_WITHIN_MS
      );

      const spinning = tabIn(
        await workbench.measure('the suite is reading the icon', SETTLES_WITHIN_MS),
        stand.terminalId
      );

      // The measurement this whole step turns on. `working` is `sync~spin`,
      // which is ONE ThemeIcon id and TWO css classes: carried across as it
      // stands it names no rule in the stylesheet, and the tab draws an empty
      // space -- on the state an agent spends most of its life in.
      assert.notEqual(spinning.glyph, 'none', 'the tab of a working agent drew no glyph at all');
      assert.equal(spinning.glyph.length, 1, `the icon is not one character: ${JSON.stringify(spinning.glyph)}`);
      // And the colour resolved: `charts.blue` is a colour id and not a colour,
      // and in a document it exists only as a variable the editor defines.
      assert.match(spinning.colour, /^(?:#|rgb)/u, `the icon colour did not resolve: ${spinning.colour}`);

      registry.amend(recordFor(stand.terminalId, 'waiting_permission', identity));
      await until(
        'the tab to take the new state',
        () => strip.tabs.some((tab) => tab.terminalId === stand.terminalId && tab.iconId === 'shield'),
        SETTLES_WITHIN_MS
      );
      const waiting = tabIn(
        await workbench.measure('the suite is reading the icon again', SETTLES_WITHIN_MS),
        stand.terminalId
      );

      // A different state draws a different character. Without this, an icon
      // hard-wired to one glyph would pass everything above.
      assert.notEqual(
        waiting.glyph,
        spinning.glyph,
        'two different states drew the same glyph, so the icon says nothing'
      );
    } finally {
      registry.forget(working.terminalId);
      await stand.end();
      await cleanUp(readiness.storageDir, stand.terminalId);
    }
  });

  test('switching tabs loses nothing and redraws nothing', async () => {
    const first = await Stand.start('04');
    const second = await Stand.start('05');
    try {
      const one = await attach(first);
      const before = await counted(one, 'before the terminal was hidden');
      const drawn = one.attachCount;

      await attach(second);
      // First is now behind Second, and its screen is alive: this is what a
      // screen per terminal buys, and what a single screen could not do.
      await first.say('ping');
      await until('the hidden terminal to answer', () => one.tail.text.includes('PONG'));

      // Nothing is being HELD for it, and that is what a screen per terminal
      // buys: the terminal nobody is looking at is still being sent to, and its
      // own screen is still parsing and still acknowledging. A build that
      // detached the hidden one and replayed it on the way back would lose
      // nothing either -- and would fail this line, which is the difference.
      assert.equal(one.unsentChars, 0, 'output was held back for a terminal nobody was looking at');
      await until(
        'the hidden screen to acknowledge what it was sent',
        () => one.unacknowledged === 0,
        SETTLES_WITHIN_MS
      );

      const report = await clickTab(first.terminalId);
      assert.equal(report.attached, first.terminalId);
      const after = await counted(one, 'after the terminal came back');

      // Everything the host posted while nobody was looking was parsed by that
      // terminal's own screen: no output waited, and none was lost.
      assert.equal(
        after.written - before.written,
        after.sent - before.sent,
        'the screen of a hidden terminal did not take everything it was sent'
      );
      assert.ok(after.sent > before.sent, 'the hidden terminal was sent nothing, so nothing was measured');
      // And it was never drawn again. A redraw from the tail looks exactly like
      // the screen that was already there, so this number is the only thing
      // that can tell them apart.
      assert.equal(one.attachCount, drawn, 'the terminal was drawn again when its tab was clicked');
    } finally {
      await second.end();
      await first.end();
    }
  });

  test('a terminal behind another is already the size it will be shown at', async () => {
    const { workbench } = await api();
    const first = await Stand.start('06');
    const second = await Stand.start('07');
    try {
      const hidden = await attach(first);
      await attach(second);
      // Waited for rather than read: `shown` is answered by the host the moment
      // it is asked, while the size comes back from the page a message later.
      await until(
        'the first terminal to be given a size at all',
        () => hidden.lastSize !== null,
        SETTLES_WITHIN_MS
      );
      const was = hidden.lastSize?.cols ?? 0;
      assert.ok(was > 0, 'the hidden terminal was never given a size at all');

      const before = await workbench.measure('before the border moves', SETTLES_WITHIN_MS);
      await workbench.dragSplitterBy(DRAG_PX, SETTLES_WITHIN_MS);
      // Asked for again rather than taken from the drag's own answer: the page
      // measures itself for several reasons now, and the report that settles a
      // drag is whichever arrives first.
      const moved = await workbench.measure('after the border moved', SETTLES_WITHIN_MS);
      assert.notEqual(
        moved.cols,
        before.cols,
        `the drag did not change the number of columns: ${JSON.stringify({ before: { cols: before.cols, width: before.terminalWidth, details: before.detailsWidth }, moved: { cols: moved.cols, width: moved.terminalWidth, details: moved.detailsWidth }, was })}`
      );

      // The acceptance line of this step: the pty behind a terminal NOBODY is
      // looking at was resized while it was hidden. A screen fitted only when it
      // is shown would resize at that moment instead, and the agent would redraw
      // its whole TUI in front of the person switching to it.
      await until(
        'the hidden terminal to be resized behind the other one',
        () => hidden.lastSize?.cols === moved.cols,
        SETTLES_WITHIN_MS
      );
      const drawn = hidden.attachCount;

      const report = await clickTab(first.terminalId);

      assert.equal(report.cols, moved.cols, 'the terminal that came forward was a different size');
      assert.equal(hidden.attachCount, drawn, 'the terminal was redrawn when it came forward');
    } finally {
      await second.end();
      await first.end();
      // The border goes back where it was, so that the tests after this one
      // start from the same panel it did.
      await workbench.dragSplitterBy(-DRAG_PX, SETTLES_WITHIN_MS);
    }
  });

  test('marks the tab of an agent that is waiting, and not the tab being read', async () => {
    const { workbench, registry, identity, readiness, strip } = await api();
    const waiting = await Stand.start('08');
    const other = await Stand.start('09');
    const record = recordFor(waiting.terminalId, 'waiting_permission', identity);
    try {
      await attach(waiting);
      await attach(other);
      registry.register(record);
      await until(
        'the record to reach the strip',
        () => namedInStrip(strip, waiting.terminalId, TAB_NAME),
        SETTLES_WITHIN_MS
      );

      const marked = tabIn(
        await workbench.measure('the suite is looking for the mark', SETTLES_WITHIN_MS),
        waiting.terminalId
      );
      assert.equal(marked.attention, true, 'an agent waiting for a person is not marked on its tab');

      const report = await clickTab(waiting.terminalId);

      // The owner's rule of 2026-08-18: it goes out when you switch to it. As a
      // function of the state and not a flag, so switching away brings it back --
      // the agent is still waiting.
      assert.equal(
        tabIn(report, waiting.terminalId).attention,
        false,
        'the tab being read is still marked, so the mark means nothing'
      );
      const back = await clickTab(other.terminalId);
      assert.equal(
        tabIn(back, waiting.terminalId).attention,
        true,
        'the mark did not come back on an agent that is still waiting'
      );
    } finally {
      registry.forget(record.terminalId);
      await other.end();
      await waiting.end();
      await cleanUp(readiness.storageDir, waiting.terminalId);
    }
  });

  test('the cross on a running terminal closes the conversation and takes the tab away', async () => {
    const { workbench, registry, identity, readiness, strip, asker } = await api();
    const stand = await Stand.start('10');
    const record = recordFor(stand.terminalId, 'idle', identity);
    try {
      await attach(stand);
      registry.register(record);
      await until('the record to reach the strip', () => namedInStrip(strip, stand.terminalId, TAB_NAME), SETTLES_WITHIN_MS);

      // The question of M3.14, answered here because a run cannot click a modal
      // at all. That it IS asked is the assertion below.
      const before = asker.asked.length;
      asker.answerNext(true);
      workbench.clickClose(stand.terminalId);

      // `closedAt` is the mark that keeps a record from ever coming back
      // (§4.2), and it is written by ONE command. A strip that disposed of the
      // terminal itself would have gone round it, and the record would come
      // back at the next restore as if nobody had ever closed it.
      await until(
        'the record to be closed by the cross',
        () => registry.get(record.terminalId)?.closedAt !== null,
        SETTLES_WITHIN_MS
      );
      assert.equal(registry.get(record.terminalId)?.isRestorable(), false);

      const report = await workbench.measure('the suite is looking for the closed tab', SETTLES_WITHIN_MS);
      assert.equal(
        report.tabs.some((tab) => tab.terminalId === stand.terminalId),
        false,
        'the tab of a closed terminal is still on the strip'
      );

      // Named, so that a build which ends a conversation on one click cannot
      // pass this by ending it silently.
      const asked = asker.asked.slice(before);
      assert.deepEqual(asked, [`End the conversation in "${TAB_NAME}"?`], 'the cross asked nothing');
    } finally {
      registry.forget(record.terminalId);
      await stand.end();
      await cleanUp(readiness.storageDir, stand.terminalId);
    }
  });

  test('a cross the person backs out of ends nothing and leaves the tab where it was', async () => {
    /*
     * The other half of the question, and the half a slip needs: saying no has
     * to leave a running agent reachable. A strip that took the tab away while
     * the dialog stood would answer for the person -- the conversation would go
     * on with nothing on the screen to reach it by, which is the state M2.16
     * measured the cost of.
     */
    const { workbench, registry, identity, readiness, strip, stage, asker } = await api();
    const stand = await Stand.start('12');
    const record = recordFor(stand.terminalId, 'idle', identity);
    try {
      await attach(stand);
      registry.register(record);
      await until('the record to reach the strip', () => namedInStrip(strip, stand.terminalId, TAB_NAME), SETTLES_WITHIN_MS);

      asker.answerNext(false);
      workbench.clickClose(stand.terminalId);

      await until(
        'the refused close to have been answered',
        () => asker.asked.some((question) => question.includes(TAB_NAME)),
        SETTLES_WITHIN_MS
      );
      // Both halves, because either alone would pass a build that got it wrong:
      // the record is not closed, and the tab is still held.
      assert.equal(registry.get(record.terminalId)?.closedAt, null, 'a refused close closed the record');
      assert.equal(stage.held.includes(stand.terminalId), true, 'a refused close took the tab away');
    } finally {
      registry.forget(record.terminalId);
      await stand.end();
      await cleanUp(readiness.storageDir, stand.terminalId);
    }
  });

  test('the cross on a terminal that has ended takes the tab away and leaves the record alone', async () => {
    const { workbench, registry, identity, readiness, stage, strip } = await api();
    const stand = await Stand.start('11');
    const record = recordFor(stand.terminalId, 'idle', identity);
    try {
      const bridge = await attach(stand);
      registry.register(record);
      await until('the record to reach the strip', () => namedInStrip(strip, stand.terminalId, TAB_NAME), SETTLES_WITHIN_MS);

      await stand.say('bye');
      await until('the process to go', () => bridge.over, SETTLES_WITHIN_MS);

      // The tab STAYS, with what the agent printed on its way out (the owner's
      // decision of 2026-08-18).
      const ended = await workbench.measure('the suite is looking at a finished terminal', SETTLES_WITHIN_MS);
      assert.equal(tabIn(ended, stand.terminalId).over, true, 'a terminal whose process went does not say so');
      assert.equal(ended.attached, stand.terminalId, 'the screen of a finished terminal was taken away');

      workbench.clickClose(stand.terminalId);
      await until(
        'the tab to leave the strip',
        () => !stage.held.includes(stand.terminalId),
        SETTLES_WITHIN_MS
      );

      // And the record is untouched. The reversible half, deliberately: an agent
      // that died on its own may still be worth resuming, and `closedAt` would
      // take that away for good in order to tidy a tab (§I.3).
      assert.equal(registry.get(record.terminalId)?.closedAt, null, 'clearing a dead tab closed the record');
      assert.equal(registry.get(record.terminalId)?.isRestorable(), true);
    } finally {
      registry.forget(record.terminalId);
      await stand.end();
      await cleanUp(readiness.storageDir, stand.terminalId);
    }
  });
});

