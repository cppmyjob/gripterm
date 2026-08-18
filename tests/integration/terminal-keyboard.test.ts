import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The keyboard of our own panel: what reaches the agent, and what must not.
 *
 * **Everything here is read at the far end.** The stand prints the CODE of every
 * byte it is given, so "the key arrived" is a number in the output rather than a
 * look at a screen (§I.1) -- and so is the thing M3.8 exists to protect: a paste
 * arrives wrapped in the bracketed-paste markers, and the difference between
 * `term.paste` and a write into the pty is visible as those six bytes.
 *
 * **What the press probe does and does not stand for.** The page dispatches the
 * key event on xterm's own textarea, which is where a real press lands, and the
 * editor's forwarding, our context key, our keybinding and our command all run
 * after it. What it cannot stand in for is the hardware and the operating
 * system's own layer -- those are the owner's eyes in M3.14.
 */

const SETTLES_WITHIN_MS = 30_000;
const LOOK_EVERY_MS = 25;

/**
 * A process that says what it was given, byte by byte.
 *
 * Three things about it are measurements rather than style, all taken 2026-08-18
 * against node-pty 1.1.0 and the ConPTY it uses by default:
 *
 *   * **It announces itself first**, because node-pty holds every call until the
 *     pty's first data event (M3.7).
 *   * **It reads in RAW mode**, as the CLI does. In cooked mode ConPTY turns
 *     input into console keys, and a lone line feed -- which is exactly what
 *     `Ctrl+J` means -- is DROPPED on the way. A stand in cooked mode reported
 *     this build losing a chord it delivers perfectly well.
 *   * **It asks for bracketed paste** (DECSET 2004), the way Claude Code does
 *     (M3.2 stage B, answer 4). The request DOES reach xterm -- the page reports
 *     it, and the test below asserts it -- but the markers do NOT come back
 *     through ConPTY on the way in: with raw mode and the mode set, the program
 *     receives the pasted text with no brackets around it. That belongs to the
 *     platform rather than to us, and it is why what this suite promises about a
 *     paste is that it arrives WHOLE rather than that it arrives framed.
 */
const STAND = `
if (process.stdin.setRawMode) { process.stdin.setRawMode(true); }
process.stdout.write('READY' + String.fromCharCode(10));
// DECSET 2004, written by code rather than as an escape: a control character
// in a source file is invisible in every diff it ever appears in.
process.stdout.write(String.fromCharCode(27) + '[?2004h');
process.stdin.resume();
let answered = 0;
process.stdin.on('data', (chunk) => {
  const codes = Array.from(chunk).map((byte) => String(byte)).join(',');
  // Numbered, and the number is what makes this countable: the pseudoconsole
  // repaints the screen it holds and a repaint re-emits lines the program
  // printed once. Two answers with one number are one answer.
  answered += 1;
  process.stdout.write('SAW ' + String(answered) + ' ' + codes + String.fromCharCode(10));
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

/**
 * Waits for the clipboard to hold something, and gives back what it holds.
 *
 * Its own waiter because reading the clipboard is asynchronous and `until` asks
 * a question that answers at once -- and because what the test then wants to
 * print, when it fails, is whatever was really there.
 */
async function clipboardHolding(what: string): Promise<string> {
  const started = Date.now();
  let text = await vscode.env.clipboard.readText();
  while (!text.includes(what) && Date.now() - started < SETTLES_WITHIN_MS) {
    await delay(LOOK_EVERY_MS);
    text = await vscode.env.clipboard.readText();
  }
  return text;
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
    const directory = await mkdtemp(join(os.tmpdir(), 'gripterm-keys-'));
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
    const terminalId = `550e8400-e29b-41d4-a716-44665531${suffix}`;
    const handle = await gateway.create({
      terminalId: { value: terminalId } as unknown as Spec['terminalId'],
      name: `keys ${suffix}`,
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

  public async end(): Promise<void> {
    // Off the strip first, which is what the cross on its tab does: a tab of
    // ours left behind would stay on the panel -- with its screen -- for the
    // whole of the run, and the suites after this one would count it (M3.9).
    (await api()).stage.removed(this.terminalId);
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

/** Brings the terminal up on the screen and puts the keyboard inside it. */
async function attach(stand: Stand): Promise<Bridge> {
  const { workbench, stage, keyboard } = await api();
  await showPanel();
  await workbench.whenReady(SETTLES_WITHIN_MS);
  stand.handle.show(false);
  await until(
    `the page to take terminal ${stand.terminalId}`,
    () => stage.attachedTerminal === stand.terminalId,
    SETTLES_WITHIN_MS
  );
  workbench.focusHalf('terminal');
  await until('the keyboard to be inside the terminal', () => keyboard.focused, SETTLES_WITHIN_MS)
    .catch(async (cause: unknown) => {
      const report = await workbench.measure('the suite is asking why the keyboard is elsewhere', SETTLES_WITHIN_MS);
      throw new Error(`${String(cause)} -- attached: ${String(report.attached)}, tabs: ${JSON.stringify(report.tabs)}, refusals: ${workbench.refusals.slice(-4).join(' | ')}`);
    });
  return await bridgeOf(stand.terminalId);
}

/**
 * Every answer the PROGRAM has given, once each.
 *
 * Distinct, and that is the whole point of the numbering: the tail is not the
 * program's bytes. The pseudoconsole repaints the screen it holds -- after a
 * resize, after a scroll -- and a repaint re-emits lines that were printed once,
 * so a text count reads one arrival as two. Two lines with one number are one
 * answer.
 */
function sawLines(bridge: Bridge): readonly string[] {
  return [...new Set(bridge.tail.text.match(/SAW \d+ [\d,]+/gu) ?? [])];
}

/**
 * The answers that carry these bytes, once each.
 *
 * Matched on the codes and never on the whole line, and at comma boundaries:
 * the line begins with a number of its own, so a search for `10` in the text
 * would find the tenth answer, and a search inside `110` would find a newline
 * that was never sent.
 */
function answersWith(bridge: Bridge, codes: string): readonly string[] {
  return sawLines(bridge).filter((line) => `,${codesOf(line)},`.includes(`,${codes},`));
}

/** The byte codes of one answer, without the number the program gave it. */
function codesOf(line: string): string {
  return line.slice(line.indexOf(' ', 'SAW '.length) + 1);
}

/**
 * Waits for the process to say it was given these bytes, and shows what it was
 * given instead when it never does.
 *
 * The evidence attached rather than left in the editor: a timeout that says only
 * "waited 30 s" cannot tell a key that never left the page from a key that
 * arrived as something else, and both are one line of output away.
 */
async function untilSeen(
  bridge: Bridge,
  since: number,
  what: string,
  codes: string
): Promise<void> {
  const { keyboard } = await api();
  await until(what, () => answersWith(bridge, codes).length > since, SETTLES_WITHIN_MS).catch(
    (cause: unknown) => {
      throw new Error(
        `${String(cause)} -- the process answered ${JSON.stringify(sawLines(bridge).slice(-6))}` +
        `, and this window refused: ${keyboard.refusals.slice(-3).join(' | ')}`
      );
    }
  );
}

suite('the keyboard of our own panel', () => {
  test('every chord in the manifest is one this window knows, and hangs on our own key', async () => {
    // The two lists that could drift: the editor reads the manifest, the page
    // reads the table. Compared against the table the RUNNING extension holds
    // rather than a copy of it compiled beside the bundle.
    const { keyboard } = await api();
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension);
    const manifest = extension.packageJSON as {
      contributes: { keybindings?: { command: string, key: string, args?: unknown, when?: string }[] };
    };
    const bound = manifest.contributes.keybindings ?? [];

    assert.deepEqual(
      bound.map((entry) => entry.key).sort((left, right) => left.localeCompare(right)),
      keyboard.chords.map((chord) => chord.id).sort((left, right) => left.localeCompare(right)),
      'the manifest binds a different set of chords than the table this window reads'
    );
    for (const entry of bound) {
      assert.equal(entry.command, 'gripterm.terminalKey', `${entry.key} runs something else`);
      assert.equal(entry.args, entry.key, `${entry.key} tells the command it is a different chord`);
      // NOT `focusedView`: that key is true for the details half too, and the
      // arrow keys would be taken from a person writing a note in it (O6).
      assert.equal(entry.when, 'gripterm.terminalFocused', `${entry.key} hangs on the wrong key`);
    }
  });

  test('a chord pressed on the page reaches the agent, and reaches it once', async () => {
    /*
     * The whole road, in one press: the page dispatches the key on xterm's own
     * textarea, the editor forwards it out of the webview, our context key lets
     * our keybinding match, our command runs, and the byte reaches the process.
     *
     * ONCE is the assertion that costs something. xterm is told to keep out of
     * these six chords precisely because the editor is going to hand each one
     * back as a command -- and a build where both answered would put two
     * newlines into an agent's prompt for one press, which no test at the pty's
     * end could attribute to either path.
     *
     * What this still does not stand for is the hardware and the operating
     * system's layer: the press is synthetic. The mechanism was measured by hand
     * in the M3.1 spike, and M3.14 is where the owner's own fingers confirm it.
     */
    const { workbench, keyboard } = await api();
    const stand = await Stand.start('01');
    try {
      const bridge = await attach(stand);
      const before = answersWith(bridge, '10').length;

      workbench.press('ctrl+j');

      // 10 is the newline `Ctrl+J` means inside the CLI's prompt, which is how a
      // multi-line question is asked at all.
      await untilSeen(bridge, before, 'the newline byte to reach the process', '10');
      await delay(500);
      const arrivals = answersWith(bridge, '10').length - before;

      assert.equal(arrivals, 1, `the press arrived ${String(arrivals)} times`);
      assert.equal(keyboard.refusals.length, 0, `this window refused: ${keyboard.refusals.join(' | ')}`);
      assert.ok(workbench.visible, 'the editor hid the panel under a chord it was supposed to give up');
    } finally {
      await stand.end();
    }
  });

  test('a chord pressed while the keyboard is elsewhere reaches nobody', async () => {
    // Both halves of the guard at once: the context key is down, so the editor
    // never runs our command, and xterm has been told to keep out of this chord,
    // so nothing answers it on the page either. A build that lost either one
    // would put a newline into an agent's prompt from a note field.
    const { workbench, keyboard } = await api();
    const stand = await Stand.start('07');
    try {
      const bridge = await attach(stand);
      workbench.focusHalf('details');
      await until('the keyboard to leave the terminal', () => !keyboard.focused, SETTLES_WITHIN_MS);
      const before = sawLines(bridge).length;

      workbench.press('ctrl+j');
      await delay(500);

      assert.deepEqual(
        sawLines(bridge).slice(before),
        [],
        'something answered a chord pressed outside the terminal'
      );
    } finally {
      await stand.end();
    }
  });

  test('a chord the editor took reaches the agent as the byte a terminal expects', async () => {
    // The command is what a keybinding runs, so this is the path a real press
    // takes from the moment the editor has decided whose the chord is.
    const { keyboard } = await api();
    const stand = await Stand.start('06');
    try {
      const bridge = await attach(stand);
      const before = answersWith(bridge, '10').length;

      await vscode.commands.executeCommand('gripterm.terminalKey', 'ctrl+j');

      // 10 is the newline `Ctrl+J` means inside the CLI's prompt, which is how a
      // multi-line question is asked at all.
      await untilSeen(bridge, before, 'the newline byte to reach the process', '10');
      const arrivals = answersWith(bridge, '10').length - before;
      assert.equal(arrivals, 1, 'the same chord arrived more than once');
      assert.equal(keyboard.refusals.length, 0, `this window refused: ${keyboard.refusals.join(' | ')}`);
    } finally {
      await stand.end();
    }
  });

  test('a chord goes nowhere while the keyboard is in the other half', async () => {
    const { workbench, keyboard } = await api();
    const stand = await Stand.start('02');
    try {
      const bridge = await attach(stand);

      workbench.focusHalf('details');
      await until('the keyboard to leave the terminal', () => !keyboard.focused, SETTLES_WITHIN_MS);
      const before = sawLines(bridge).length;
      const refused = keyboard.refusals.length;

      // Through the command itself, which is what a `when` clause protects and
      // what nothing stops anybody calling: the palette, a script, another
      // extension. The rule has to live in the command as well as in the clause.
      await vscode.commands.executeCommand('gripterm.terminalKey', 'ctrl+j');
      await delay(300);

      assert.deepEqual(sawLines(bridge).slice(before), [], 'a chord reached the pty from the details half');
      assert.ok(
        keyboard.refusals.length > refused,
        'nothing was sent and nothing was said about it either'
      );
    } finally {
      await stand.end();
    }
  });

  test('a chord goes nowhere while the panel is hidden', async () => {
    const { keyboard } = await api();
    const stand = await Stand.start('03');
    try {
      const bridge = await attach(stand);

      await vscode.commands.executeCommand('workbench.action.togglePanel');
      // The extension lowers the key, and this is why it must: a page that is
      // gone cannot lower it, and every one of those chords would stay taken
      // from the person for the whole window.
      await until('the keyboard to be given up', () => !keyboard.focused, SETTLES_WITHIN_MS);
      const before = sawLines(bridge).length;

      await vscode.commands.executeCommand('gripterm.terminalKey', 'ctrl+r');
      await delay(300);

      assert.deepEqual(sawLines(bridge).slice(before), [], 'a chord reached the pty from behind a hidden panel');
    } finally {
      await showPanel();
      await stand.end();
    }
  });

  test('a paste arrives whole, which is what the agent needs of it', async () => {
    // The defect this step exists to avoid: text written straight into the pty
    // loses the bracketed-paste markers, a multi-line paste becomes a run of
    // Enter presses, and Claude Code sends the first line as a finished prompt.
    // The markers are `ESC [ 2 0 0 ~` and `ESC [ 2 0 1 ~` -- the codes below.
    const { workbench } = await api();
    const theirs = await vscode.env.clipboard.readText();
    const stand = await Stand.start('04');
    try {
      const bridge = await attach(stand);
      // The program's own request has to have crossed ConPTY, our channel and the
      // replay before any of this means anything. Measured 2026-08-18 with a
      // stand of its own: `ESC[?2004h` DOES pass through the ConPTY node-pty
      // uses by default, so a page that reports it off is our defect and not the
      // platform's.
      const settled = await workbench.measure('is bracketed paste on', SETTLES_WITHIN_MS);
      assert.equal(
        settled.bracketedPaste,
        true,
        'the program never asked for bracketed paste, so nothing below is about our side'
      );
      await vscode.env.clipboard.writeText('first line\nsecond line');

      // Nothing selected, so the right button pastes -- the owner's decision of
      // 2026-08-18 and the editor's own default on Windows.
      workbench.select(false);
      workbench.rightClick();

      /*
       * WHOLE, and in one piece: `first line`, a carriage return, `second line`
       * in a single arrival. That is what `term.paste` buys on this platform and
       * it is the thing the defect is about -- a paste handed over line by line
       * is a run of Enter presses, and Claude Code sends the first line as a
       * finished prompt before the rest has arrived.
       *
       * NOT the bracketed-paste markers, and that is measured rather than
       * conceded: ConPTY strips them from the input even with the program in raw
       * mode and the mode set (2026-08-18, own stand). No terminal built on this
       * pseudoconsole can deliver them, and a test that asserted them would be
       * asserting against the platform.
       */
      const whole = '102,105,114,115,116,32,108,105,110,101,13,115,101,99,111,110,100,32,108,105,110,101';
      await untilSeen(bridge, answersWith(bridge, whole).length, 'the whole paste to arrive in one piece', whole);
    } finally {
      // The person's own clipboard, put back: this suite runs on their machine.
      await vscode.env.clipboard.writeText(theirs);
      await stand.end();
    }
  });

  test('Ctrl+C copies when something is selected, and interrupts when nothing is', async () => {
    // The owner's decision of 2026-08-18 and the editor's own rule for its
    // terminal. Both halves are here because the interesting one is the pair:
    // a build that always copied would take the interrupt away from an agent,
    // and a build that always interrupted would lose the selection.
    const { workbench } = await api();
    const theirs = await vscode.env.clipboard.readText();
    const stand = await Stand.start('08');
    try {
      const bridge = await attach(stand);
      await vscode.env.clipboard.writeText('nothing of ours');

      workbench.select(true);
      workbench.press('ctrl+c');

      const copied = await clipboardHolding('READY');
      assert.ok(copied.includes('READY'), `the clipboard holds ${JSON.stringify(copied.slice(0, 80))}`);
      // 3 is the interrupt. It must NOT have been sent: the person was copying.
      assert.deepEqual(
        answersWith(bridge, '3'),
        [],
        'the agent was interrupted by a press that was meant to copy'
      );

      const before = answersWith(bridge, '3').length;
      workbench.select(false);
      workbench.press('ctrl+c');

      await untilSeen(bridge, before, 'the interrupt to reach the process', '3');
    } finally {
      await vscode.env.clipboard.writeText(theirs);
      await stand.end();
    }
  });

  test('Shift+Insert pastes, which is the other way people do it', async () => {
    const { workbench } = await api();
    const theirs = await vscode.env.clipboard.readText();
    const stand = await Stand.start('09');
    try {
      const bridge = await attach(stand);
      await vscode.env.clipboard.writeText('pasted by the old way');
      const before = answersWith(bridge, '112,97,115,116,101,100').length;

      workbench.select(false);
      workbench.press('shift+insert');

      // `pasted` -- enough of it to be sure it is ours and not an echo.
      await untilSeen(bridge, before, 'the paste to reach the process', '112,97,115,116,101,100');
    } finally {
      await vscode.env.clipboard.writeText(theirs);
      await stand.end();
    }
  });

  test('the right button copies what is selected', async () => {
    const { workbench } = await api();
    const theirs = await vscode.env.clipboard.readText();
    const stand = await Stand.start('05');
    try {
      await attach(stand);
      await vscode.env.clipboard.writeText('nothing of ours');

      workbench.select(true);
      workbench.rightClick();

      const copied = await clipboardHolding('READY');

      assert.ok(copied.includes('READY'), `the clipboard holds ${JSON.stringify(copied.slice(0, 80))}`);
    } finally {
      await vscode.env.clipboard.writeText(theirs);
      await stand.end();
    }
  });
});
