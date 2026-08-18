import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * A terminal of ours, on our own screen, in the only place either half is real:
 * a running editor, a running pty, a running xterm.
 *
 * **Everything here is a number, and both ends produce their own.** The host
 * knows what it read from the pty and what it posted; the page knows what it
 * wrote into xterm and what it acknowledged. "The output arrived" is then an
 * equality rather than a look at a screen (§I.1), and every claim of M3.7 has a
 * side that can be wrong:
 *
 *   * output arrived -> the page wrote exactly as many code units as the host
 *     posted, measured as a difference so that the replay cancels;
 *   * input arrived -> a process that says nothing until it is spoken to says
 *     something;
 *   * the size arrived -> the process reports the columns the page reports;
 *   * back-pressure engages -> a page told to stop acknowledging stops the pty,
 *     and arrivals STOP;
 *   * invisibility releases it -> the same flood with the panel hidden keeps
 *     arriving, and the screen catches up when it comes back.
 *
 * The stand process is quiet on purpose. A terminal that prints a banner would
 * make every count above a race between the assertion and the banner.
 */

const SETTLES_WITHIN_MS = 30_000;

/** Long enough for a burst to cross the channel; short enough to fail a hang. */
const DRAINS_WITHIN_MS = 60_000;

/** How often a wait looks again. Small: these are milliseconds-scale events. */
const LOOK_EVERY_MS = 25;

/** How many times a pair of counts is retried before the stream is called restless. */
const COUNTING_ATTEMPTS = 10;

/** Lines the stand floods with, and the width of each. 20 000 x 81 = 1.62 M code units, the M3.2 stream. */
const FLOOD_LINES = 20_000;

/**
 * How deep into a flood a receipt is checked against what the screen has taken in.
 *
 * Deep enough that the stream is plainly still running: the question "has the
 * screen really taken in what it acknowledged" only has an answer while the pty
 * is still producing. At rest xterm has drained its queue by the time the
 * question crosses the channel -- which is how the first version of this test
 * passed a page acknowledging on arrival (M19).
 */
const SAMPLE_UNDER_FLOOD_CHARS = 400_000;

/**
 * How long the screen is made to take over each message while that is measured.
 *
 * The probe exists because this machine's xterm is FASTER than its pty on plain
 * output, so nothing falls behind and the two possible receipts report the same
 * numbers. Forty milliseconds is two frames -- far less than a real screen
 * falls behind by under an agent's TUI, and enough that a receipt sent on
 * arrival is caught by a whole flood.
 */
const SLOW_SCREEN_MS = 40;

type Gateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];

/**
 * A process that says one word and then nothing until it is spoken to.
 *
 * Every count in this suite is a difference between two reports, and a process
 * that printed on its own would put its own output inside those differences. It
 * answers three words, and it exits on the fourth so that the end of a terminal
 * can be watched as well as its life.
 *
 * **The one word is not decoration and it is not a banner.** Measured 2026-08-17
 * (node-pty 1.1.0 on Windows): `WindowsTerminal` queues `write`, `resize` and
 * `kill` until its socket produces its FIRST DATA EVENT. A process that never
 * printed anything would therefore never receive anything either -- the stand
 * would wait for an answer to a question that is still sitting in node-pty's
 * queue. `READY` is what unblocks that queue, and every measurement below is
 * taken after it has arrived.
 */
const STAND = `
process.stdout.write('READY\\n');
// Announced rather than only answered, and the listener is not decoration:
// measured 2026-08-17, node caches the console size and refreshes it only when
// this event fires, and on Windows nothing watches for the event until somebody
// listens for it. Without this line the process reports the size it was spawned
// with for ever -- which this suite spent an hour reading as a broken channel,
// while ConPTY had reported the new size in the output stream all along.
process.stdout.on('resize', () => { size(); });
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', (chunk) => {
  for (const character of chunk) {
    if (character === '\\r' || character === '\\n') {
      answer(line);
      line = '';
    } else {
      line += character;
    }
  }
});
function answer(command) {
  if (command === 'ping') {
    process.stdout.write('PONG\\n');
    return;
  }
  if (command === 'size') {
    size();
    return;
  }
  if (command === 'flood') {
    for (let index = 0; index < ${String(FLOOD_LINES)}; index += 1) {
      process.stdout.write('x'.repeat(80) + '\\n');
    }
    process.stdout.write('FLOODED\\n');
    return;
  }
  if (command === 'bye') {
    process.exit(3);
  }
}
function size() {
  process.stdout.write('SIZE ' + String(process.stdout.columns) + 'x' + String(process.stdout.rows) + '\\n');
}
setInterval(() => { /* stay alive with nothing to say */ }, 60_000);
`;

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

/** Everything said while a terminal was under test, so a refusal can be read rather than assumed. */
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

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Waits for something to become true, and says what it was still waiting for when it gave up. */
async function until(
  what: string,
  answer: () => boolean,
  withinMs = DRAINS_WITHIN_MS,
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

/**
 * One terminal of our own, wired to the panel the window is really using.
 *
 * The gateway comes from the extension's own factory and takes the extension's
 * own stage as its audience -- so what is under test is the composition, driven
 * with a process this suite made, rather than a second copy of it compiled
 * beside the bundle.
 */
class Stand {
  public readonly handle: Handle;
  public readonly terminalId: string;
  public readonly said: readonly string[];
  private readonly _gateway: Gateway;
  private readonly _directory: string;
  private readonly _workbench: GriptermApi['workbench'];

  private constructor(
    gateway: Gateway,
    handle: Handle,
    terminalId: string,
    directory: string,
    workbench: GriptermApi['workbench'],
    said: readonly string[]
  ) {
    this.said = said;
    this._gateway = gateway;
    this.handle = handle;
    this.terminalId = terminalId;
    this._directory = directory;
    this._workbench = workbench;
  }

  public static async start(suffix: string): Promise<Stand> {
    const directory = await mkdtemp(join(os.tmpdir(), 'gripterm-stand-'));
    const script = join(directory, 'stand.js');
    await writeFile(script, STAND, 'utf8');

    const { makeGateway, stage, workbench } = await api();
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
    const terminalId = `550e8400-e29b-41d4-a716-44665530${suffix}`;
    const handle = await gateway.create({
      terminalId: { value: terminalId } as unknown as Spec['terminalId'],
      name: `stand ${suffix}`,
      // NOT the directory the script is in: Windows locks a running process's
      // working directory, and `IPty.kill()` is asynchronous by construction
      // (О4), so the tidy-up below would race the death of the process.
      cwd: os.tmpdir(),
      env: {},
      shellPath: nodePath(),
      shellArgs: [script],
    });
    const stand = new Stand(gateway, handle, terminalId, directory, workbench, log.lines);
    // Nothing is asked of a pty that has not spoken: until it has, node-pty is
    // holding every call to it (see `STAND`), and a test written on top of that
    // queue would be measuring the queue.
    const bridge = await bridgeOf(terminalId);
    await until(
      'the stand to announce itself',
      () => bridge.tail.text.includes('READY'),
      SETTLES_WITHIN_MS
    ).catch((cause: unknown) => {
      // With what the gateway said while it was trying: a stand that never
      // starts is usually a refusal, and a refusal nobody reads is the failure
      // mode this whole build is written against.
      throw new Error(`${String(cause)} -- the gateway said: ${stand.said.join(' | ')}`);
    });
    return stand;
  }

  /**
   * Types a line the way the person's keyboard does: through the page, into the
   * pty.
   *
   * Synchronous, deliberately: it is called from inside a `until` predicate,
   * where a promise nobody waits on would be a keystroke arriving at a time
   * nothing in the test can name.
   */
  public say(word: string): void {
    this._workbench.type(`${word}\r`);
  }

  public async end(): Promise<void> {
    // Off the strip first, which is what the cross on its tab does: a tab of
    // ours left behind would stay on the panel -- with its screen -- for the
    // whole of the run, and the suites after this one would count it (M3.9).
    (await api()).stage.removed(this.terminalId);
    this._gateway.dispose();
    // Swallowed deliberately: this runs in a `finally`, and a temp directory
    // that could not be removed must not be reported as the failure of the test
    // that was running -- which is exactly what it did on the first run of this
    // suite, hiding seven results behind seven EBUSY.
    await rm(this._directory, { recursive: true, force: true }).catch(() => null);
  }
}

type Bridge = NonNullable<ReturnType<GriptermApi['stage']['bridgeFor']>>;

/** The bridge holding this terminal, which is where the host's own counts live. */
async function bridgeOf(terminalId: string): Promise<Bridge> {
  const { stage } = await api();
  const bridge = stage.bridgeFor(terminalId);
  assert.ok(bridge, `no bridge for ${terminalId}`);
  return bridge;
}

/**
 * The two counts of the same moment: what the host has posted, and what the page
 * has written.
 *
 * Taken while the stream is standing still, and retried until it is. Without
 * that, the pair is not of one moment at all -- a chunk arriving between reading
 * the host's total and hearing the page's answer makes the two disagree by
 * exactly that chunk, which is how this assertion first failed by six code units
 * on 2026-08-17.
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

/** Brings a terminal to the screen and waits until the page says it is holding it. */
async function attach(stand: Stand): Promise<void> {
  const { workbench, stage } = await api();
  await showPanel();
  await workbench.whenReady(SETTLES_WITHIN_MS);
  stand.handle.show(false);
  await until(
    `the page to take terminal ${stand.terminalId}`,
    () => stage.attachedTerminal === stand.terminalId,
    SETTLES_WITHIN_MS
  );
  // And the page's own word for it, not just the host's intention.
  const report = await workbench.measure('the suite is checking what is on screen', SETTLES_WITHIN_MS);
  assert.equal(report.attached, stand.terminalId);
}

suite('a terminal of ours, on our own screen', () => {
  test('everything the host posts is written, and the page counts it the same', async () => {
    const stand = await Stand.start('01');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      const before = await counted(bridge, 'before the process says anything');

      stand.say('ping');
      await until('the process to answer', () => bridge.tail.text.includes('PONG'));

      const after = await counted(bridge, 'after the process answered');

      // A difference rather than a total, so that whatever was replayed at
      // attach cancels: what the host posted between the two counts is exactly
      // what the page wrote between them. A message dropped anywhere in between
      // shows up here as an inequality.
      assert.equal(
        after.written - before.written,
        after.sent - before.sent,
        `the page wrote ${String(after.written - before.written)} of the ${String(after.sent - before.sent)} code units posted`
      );
      assert.ok(after.written > before.written, 'the page wrote nothing at all');
    } finally {
      await stand.end();
    }
  });

  test('the size of the screen reaches the terminal, and every later size reaches the pty', async () => {
    const { workbench } = await api();
    const stand = await Stand.start('02');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      const settled = await workbench.measure('the suite is reading the size', SETTLES_WITHIN_MS);

      /*
       * The pseudoconsole's own acknowledgement, taken out of the output
       * stream: ConPTY answers a resize with `ESC[8;rows;cols t` and repaints at
       * the new width.
       *
       * **That it answers AT ALL is the assertion, and that is a measurement
       * rather than a weak claim (2026-08-18).** It answers the first resize a
       * pty is given and says nothing about the ones after it -- and it answers
       * NOTHING when two resizes land on top of each other, which is exactly
       * what a screen made for a freshly attached terminal used to do with its
       * two truthful answers about its own size (`TerminalBridge.resize`). So
       * this line is red on a build that sends both and green on one that sends
       * one, while the size the page finally settles at is asserted below, on
       * this side of the boundary where every resize can still be seen.
       *
       * What the PROGRAM makes of it is a separate and open question: measured
       * here, `process.stdout.columns` inside a pty never moves from the size it
       * was spawned with, whatever the pseudoconsole is told, on the build
       * before M3.9 exactly as on this one (A48 -- a live agent and the owner's
       * eyes, M3.14).
       */
      await until(
        'the pseudoconsole to acknowledge a resize at all',
        () => bridge.tail.text.includes(`${String.fromCharCode(27)}[8;`),
        SETTLES_WITHIN_MS
      ).catch((cause: unknown) => {
        // With what the gateway said while it was trying: a resize that never
        // reached the pseudoconsole and one it refused look the same from here.
        throw new Error(`${String(cause)} -- the gateway said: ${stand.said.join(' | ')}`);
      });
      // And the size the page settled at is the one the pty was last told.
      await until(
        `the pty to be told ${String(settled.cols)}x${String(settled.rows)}`,
        () => bridge.lastSize?.cols === settled.cols && bridge.lastSize.rows === settled.rows,
        SETTLES_WITHIN_MS
      );

      // And a later one: the border is dragged, the page re-fits, and the size
      // it settled at is the size the pty was told to take.
      const moved = await workbench.dragSplitterBy(-90, SETTLES_WITHIN_MS);
      await until(
        `the pty to be told ${String(moved.cols)}x${String(moved.rows)}`,
        () => bridge.lastSize?.cols === moved.cols && bridge.lastSize.rows === moved.rows,
        SETTLES_WITHIN_MS
      );

      await workbench.dragSplitterBy(90, SETTLES_WITHIN_MS);
    } finally {
      await stand.end();
    }
  });

  test('the same size twice is one resize', async () => {
    /*
     * A rule with a measured price. A screen made for a terminal that has just
     * been attached answers with its size TWICE -- once through xterm's own
     * `onResize`, once because the page says it unprompted -- and both answers
     * are right. Sent both, they reach ConPTY within a millisecond of each other
     * and the pseudoconsole acknowledges NEITHER: no `ESC[8;rows;cols t` in the
     * output stream, and the agent draws every frame at a width nobody has.
     *
     * It is counted here rather than watched at the pty, because the
     * pseudoconsole answers only the FIRST resize a terminal ever gets -- so
     * from down there one call and two look the same.
     */
    const stand = await Stand.start('09');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      const settled = await api().then(async ({ workbench }) =>
        await workbench.measure('the suite is reading the size', SETTLES_WITHIN_MS));
      const before = bridge.resizeCount;

      const narrower = settled.cols - 7;
      bridge.resize(narrower, settled.rows);
      bridge.resize(narrower, settled.rows);
      bridge.resize(narrower, settled.rows);

      assert.equal(bridge.resizeCount - before, 1, 'the pty was told one size more than once');
      assert.deepEqual(
        { cols: bridge.lastSize?.cols, rows: bridge.lastSize?.rows },
        { cols: narrower, rows: settled.rows },
        'the bridge kept a size other than the one it sent'
      );
    } finally {
      await stand.end();
    }
  });

  test('input is not lost under a flood', async () => {
    const stand = await Stand.start('03');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);

      stand.say('flood');
      // Typed WHILE the flood is on the wire rather than after it: the acceptance
      // line is that a person can keep working while an agent runs `pnpm
      // install`, and that is exactly the moment the channel is busiest.
      await until('the flood to start arriving', () => bridge.sentChars > 0);
      stand.say('ping');

      await until('the flood to finish', () => bridge.tail.text.includes('FLOODED'));
      await until('the answer that was typed under it', () => bridge.tail.text.includes('PONG'));
    } finally {
      await stand.end();
    }
  });

  test('a screen that stops answering stops the process, and answering again starts it', async () => {
    const { workbench } = await api();
    const stand = await Stand.start('04');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);

      // The consumer is made unhealthy on purpose: without this, "back-pressure
      // works" is unfalsifiable, because a healthy consumer never needs a pause
      // and a build with no `pause()` at all passes every test it takes.
      workbench.receipts(false);
      await delay(200);
      stand.say('flood');

      await until('the process to be held back', () => bridge.paused, SETTLES_WITHIN_MS);

      // And it really stopped, at the pty rather than in a counter of ours: the
      // arrivals themselves cease. Measured over a window long enough that a
      // stream still running would plainly grow -- 1.6 million code units cross
      // this channel in under a second when nothing holds them.
      const heldAt = bridge.tail.text.length;
      await delay(1500);
      assert.equal(
        bridge.tail.text.length,
        heldAt,
        'output kept arriving after the pty was paused, so nothing was really held back'
      );
      assert.ok(
        bridge.unacknowledged > 0,
        'the flow thinks nothing is outstanding while the page is silent'
      );

      // Reversible, which is the whole point (§I.3): the page settles what it
      // owes the moment receipts come back, and the process runs on.
      workbench.receipts(true);
      await until('the process to be let go', () => !bridge.paused, SETTLES_WITHIN_MS);
      await until('the flood to finish after all', () => bridge.tail.text.includes('FLOODED'));
    } finally {
      workbench.receipts(true);
      await stand.end();
    }
  });

  test('a panel that goes away releases the agent it was holding back, and the screen catches up when it returns', async () => {
    const { workbench } = await api();
    const stand = await Stand.start('05');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);

      /*
       * PAUSED FIRST, and this order is the whole test.
       *
       * Written the other way round until 2026-08-18 -- hide the panel, then
       * flood -- it asserted `paused === false` on a terminal that had never
       * been paused, so "invisibility releases the process" had nothing to
       * release and the mutation deleting that release from `hide()` survived
       * it (M13 of the M3.7 battery). The pause has to exist before the panel
       * goes, or the assertion is about a default rather than about a rule.
       */
      workbench.receipts(false);
      await delay(200);
      stand.say('flood');
      await until('the process to be held back', () => bridge.paused, SETTLES_WITHIN_MS);

      await vscode.commands.executeCommand('workbench.action.togglePanel');
      await until('the page to notice it is hidden', () => !workbench.visible, SETTLES_WITHIN_MS);

      // The rule this test exists for. A hidden webview keeps its page but stops
      // acknowledging -- Chromium clamps its timers -- so a build that waited for
      // receipts would leave this pty paused for as long as the panel stayed
      // shut, and the agent would be sitting against a full buffer right now.
      await until(
        'the agent to be let go by the panel going away',
        () => !bridge.paused,
        SETTLES_WITHIN_MS
      );
      await until('the flood to finish with nobody watching', () => bridge.tail.text.includes('FLOODED'));

      const writtenWhileAway = bridge.unsentChars;
      assert.ok(writtenWhileAway > 0, 'nothing was kept for the screen that was not looking');

      await showPanel();
      await until('the page to be visible again', () => workbench.visible, SETTLES_WITHIN_MS);
      // The receipts come back with the panel, and the debt the page kept while
      // it was silent is settled against a flow that has already forgotten it --
      // which is what the clamp at zero in `OutputFlow.acknowledged` is for.
      workbench.receipts(true);
      await until(
        'the screen to catch up on what it missed',
        () => bridge.unsentChars === 0,
        SETTLES_WITHIN_MS
      );

      const after = await workbench.measure('after the panel came back', SETTLES_WITHIN_MS);
      assert.equal(after.attached, stand.terminalId);
    } finally {
      workbench.receipts(true);
      await stand.end();
    }
  });

  test('a terminal that ends says so, and its screen stays where it was', async () => {
    const { workbench, stage } = await api();
    const stand = await Stand.start('06');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      const before = await workbench.measure('before the process goes', SETTLES_WITHIN_MS);

      stand.say('ping');
      await until('the process to answer', () => bridge.tail.text.includes('PONG'));
      stand.say('bye');

      await until('the bridge to see the process go', () => bridge.over, SETTLES_WITHIN_MS);
      const after = await workbench.measure('after the process went', SETTLES_WITHIN_MS);

      // The screen and the tab STAY, by the owner's decision of 2026-08-18: what
      // an agent printed on its way out is the whole of what a person has left
      // to read, and it waits for them to close it (M3.9). Until that decision
      // the page let the terminal go here and this line read `null`.
      assert.equal(after.attached, stand.terminalId);
      assert.equal(stage.attachedTerminal, stand.terminalId);
      // NOT cleared: the line saying it is over is written under what the agent
      // printed rather than instead of it.
      assert.ok(
        after.written > before.written,
        'the screen was emptied when the process ended'
      );
    } finally {
      // Taken off the strip by hand, because nothing else takes it off: this is
      // the same act the cross performs, and without it the tab would stay for
      // as long as the window is open.
      stage.removed(stand.terminalId);
      await stand.end();
    }
  });

  test('a panel closed and opened again comes back holding the same terminal', async () => {
    // The rehydration handshake, which is what `ready` is for beyond start-up:
    // a page the editor threw away has an empty xterm and no idea which agent it
    // belongs to, and this is the only thing that puts one back on it.
    const { workbench, stage } = await api();
    const stand = await Stand.start('07');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      stand.say('ping');
      await until('the process to answer', () => bridge.tail.text.includes('PONG'));

      await vscode.commands.executeCommand('workbench.action.closePanel');
      await delay(500);
      await showPanel();
      await workbench.whenReady(SETTLES_WITHIN_MS);
      await until(
        'the page to take the terminal again',
        () => stage.attachedTerminal === stand.terminalId,
        SETTLES_WITHIN_MS
      );

      const report = await workbench.measure('after the panel was opened again', SETTLES_WITHIN_MS);

      assert.equal(report.attached, stand.terminalId);
      // Whatever the editor did with the page -- kept it or rebuilt it -- what is
      // on the screen is this terminal's output and not an empty box.
      assert.ok(report.written > 0, 'the screen came back with nothing on it');
    } finally {
      await stand.end();
    }
  });

  test('the host is never told more has landed than the screen has taken in', async () => {
    /*
     * The honesty of the receipt, sampled WHILE the flood is running -- which is
     * the only time the question has an answer.
     *
     * The invariant: a receipt is posted from xterm's own parse callback, and
     * the page's count of what it has parsed is raised in that same callback
     * BEFORE the receipt goes out. So whatever the host believes has been
     * acknowledged must already be inside the screen, at every instant. Read the
     * host's belief first and the page's count after it, and the comparison
     * survives the round trip between them: both numbers only grow.
     *
     * Sampled mid-flood UNDER A SLOW SCREEN, and both halves of that were paid
     * for. Comparing the totals after the flood proved nothing: with the pty
     * finished, xterm drains its queue in the time the question takes to travel.
     * Sampling under an ordinary flood proved nothing either: on this machine
     * xterm parses 1.6 million code units of plain lines FASTER than the pty
     * produces them, so there is no queue to be behind on and both builds report
     * the same numbers. The `linger` probe is what makes the screen the slow
     * side -- as a real one is under a real agent's TUI (M3.2 stage B measured
     * half a million characters of lag) -- and only then does an arrival-side
     * receipt become a claim that can be caught (M19, 2026-08-18).
     */
    const { workbench } = await api();
    const stand = await Stand.start('08');
    try {
      await attach(stand);
      const bridge = await bridgeOf(stand.terminalId);
      const before = await counted(bridge, 'before the flood');

      workbench.linger(SLOW_SCREEN_MS);
      stand.say('flood');
      await until(
        'a good part of the flood to be on the wire',
        () => bridge.sentChars - before.sent > SAMPLE_UNDER_FLOOD_CHARS
      );
      // In this order, and the order is the test: what the host believes, then
      // what the page says. The other way round would compare a later belief
      // with an earlier count and prove nothing.
      const acknowledged = bridge.sentChars - bridge.unacknowledged - before.sent;
      const under = await workbench.measure('the suite is sampling under the flood', SETTLES_WITHIN_MS);

      assert.ok(
        acknowledged > 0,
        'nothing had been acknowledged at all, so this sample says nothing about receipts'
      );
      assert.ok(
        under.written - before.written >= acknowledged,
        `the host was told ${String(acknowledged)} code units had landed while the screen had taken in ${String(under.written - before.written)}`
      );

      // And when it is all over, nothing was lost on the way: every code unit
      // the host posted is inside the screen. The scale of "it all" is the wait
      // above rather than a count of what the process printed -- what crosses
      // this channel is ConPTY's repaint of that output, which is its own
      // stream and not the program's bytes.
      workbench.linger(0);
      await until('the flood to finish', () => bridge.tail.text.includes('FLOODED'));
      const after = await counted(bridge, 'after the flood');
      assert.equal(
        after.written - before.written,
        after.sent - before.sent,
        `the screen took in ${String(after.written - before.written)} of the ${String(after.sent - before.sent)} code units posted`
      );
    } finally {
      workbench.linger(0);
      await stand.end();
    }
  });

  test('a question is answered by its own answer, not by whatever the page said last', async () => {
    /*
     * The correlation in `WorkbenchView`, which belongs to the measuring
     * apparatus rather than to the product -- and is therefore the one thing
     * here that nothing else can catch.
     *
     * The page measures ITSELF as well as answering: an attach, an end, a
     * restyle each produce a report of their own. A waiter handed the first
     * report to arrive is handed one taken BEFORE its own question, and every
     * assertion in this file is written on top of those answers. Found exactly
     * that way on 2026-08-17 (a report of `attached: null` about a terminal that
     * had ended a moment earlier) and left untested until the mutation removing
     * the correlation survived a whole battery (M21, 2026-08-18).
     *
     * Provoked rather than waited for: the two self-reports and the question go
     * out in ONE turn, so both are on the wire before any answer can come back,
     * and the page's own message order decides the rest.
     */
    const { workbench } = await api();
    await showPanel();
    await workbench.whenReady(SETTLES_WITHIN_MS);
    const before = await workbench.measure('what the page looks like before the probe', SETTLES_WITHIN_MS);
    try {
      workbench.post({ kind: 'restyle', fontFamily: before.fontFamily, fontSize: before.fontSize + 1 });
      workbench.post({ kind: 'restyle', fontFamily: before.fontFamily, fontSize: before.fontSize + 2 });

      const answer = await workbench.measure('how big is the type now', SETTLES_WITHIN_MS);

      assert.equal(
        answer.fontSize,
        before.fontSize + 2,
        'the question was settled by a report the page had already sent about something else'
      );
    } finally {
      // Put back, because a font size is a real change to a real page and every
      // test after this one measures the same one.
      workbench.post({ kind: 'restyle', fontFamily: before.fontFamily, fontSize: before.fontSize });
      await workbench.measure('the page is put back as it was', SETTLES_WITHIN_MS);
    }
  });

  test('the launch gate lets a person through while the panel is up', async () => {
    // The other half -- refusing when the page does not come up -- is what M2.16
    // paid for: a script blocked by the policy would leave `claude` running
    // where nobody can see it. It is exercised by mutation rather than here,
    // because a page that IS up cannot be asked to not be up without a seam that
    // would exist for no other reason.
    const { stage } = await api();
    await showPanel();

    assert.equal(await stage.whenPageIsUp(SETTLES_WITHIN_MS), null);
  });
});
