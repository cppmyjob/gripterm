import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * ONE suite over BOTH engines, which is the whole point of it.
 *
 * `TerminalGateway` has two implementations from M3.4 on, and a suite written
 * against either one of them separately would let them drift apart in exactly the
 * places a record depends on: the pid, the exit code, whether a closed terminal
 * is still listed. Two engines behind one port that answer differently is a
 * record written by one window and read wrongly by the next.
 *
 * Here rather than in the jest run because one of the two engines IS the editor:
 * `createTerminal`, `onDidCloseTerminal` and `exitStatus` are the platform's, and
 * a fake would be free to invent all three. The other engine needs no editor at
 * all, and it is run here anyway so that both answers come from the same
 * assertions rather than from two suites that look alike.
 *
 * **Both gateways come from the extension's own factory** (`makeGateway`), not
 * from an import of the adapter. An import would compile a SECOND copy of the
 * adapter beside the bundle the editor is running and check that copy -- and, on
 * this layout, would not even load: the compiled copy resolves `@gripterm/core`
 * through `node_modules`, where an installed extension has none.
 *
 * **What is deliberately NOT in the contract, by name.** `runLaunchCommand`
 * exists for `gripterm.launch.mode: shell` -- a line typed into the person's own
 * shell once that shell goes quiet -- and `own` refuses that mode outright
 * (`chooseEngine`). Requiring it here would be requiring `shell` of an engine
 * that cannot have it. The MEMBER is still required of both, and that is asserted
 * below; only its behaviour is out.
 */

/** The domain types, taken from the extension's own API -- see `terminal-gateway.test.ts` for why. */
type Gateway = GriptermApi['gateway'];
type MadeGateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];
type Exit = Parameters<Parameters<Handle['onDidClose']>[0]>[0];

/**
 * The one member whose behaviour is out of the contract.
 *
 * Typed as a key of the handle, so a rename of the method turns this exclusion
 * into a compile error rather than into an exclusion of nothing.
 */
const OUT_OF_CONTRACT: readonly (keyof Handle)[] = ['runLaunchCommand'];

/** The gateway keys on `.value` alone; the brand exists to stop this happening anywhere but a test. */
function idFor(suffix: string): Spec['terminalId'] {
  return { value: `550e8400-e29b-41d4-a716-4466554${suffix}` } as unknown as Spec['terminalId'];
}

/** A process that exits with the code we ask for, without a shell profile in the way. */
function exiting(code: number): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', `exit ${String(code)}`] }
    : { path: '/bin/sh', args: ['-c', `exit ${String(code)}`] };
}

/** A process that stays up until the terminal is disposed, so its pid can be asked about. */
function lingering(): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'pause'] }
    : { path: '/bin/sh', args: ['-c', 'read line'] };
}

function nodePath(): string {
  const found = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/u)[0];
  return found === undefined ? 'node' : found.trim();
}

/** What the operating system calls the process behind a pid. The check that the number is the right one. */
function imageNameOf(pid: number): string {
  return process.platform === 'win32'
    ? execFileSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
}

/** Everything said while a gateway was under test, so a refusal can be read rather than assumed. */
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

/** Waits for something that happens on somebody else's schedule, or gives up saying what it wanted. */
async function waitFor(
  what: string,
  ready: () => boolean | Promise<boolean>,
  ms = 20000
): Promise<void> {
  const until = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Resolves with the exit the gateway reported, or rejects if the terminal outlives the wait. */
async function closeOf(handle: Handle, ms = 20000): Promise<Exit> {
  return await new Promise<Exit>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`the terminal did not close within ${String(ms)} ms`));
    }, ms);
    const subscription = handle.onDidClose((exit) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(exit);
    });
  });
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

interface EngineUnderTest {
  /** What the gateway must call itself, and what the setting asks for. */
  readonly engine: 'editor' | 'own';
  /** Whether a handle of this engine carries a screen (§4.1: `own` has one, `editor` has none). */
  readonly hasScreen: boolean;
}

const ENGINES: readonly EngineUnderTest[] = [
  { engine: 'editor', hasScreen: false },
  { engine: 'own', hasScreen: true },
];

/**
 * A gateway of the engine under test, made the way the window makes its own.
 *
 * The `own` half is NOT allowed to skip itself: `build:extension` copies the
 * addon and the integration run performs that build, so a fallback here is a
 * broken build rather than a machine without a pty -- and a suite that quietly
 * accepted the editor's gateway twice would report a green run for an engine it
 * never touched (the vacuum found by mutation in M1.5 and M2.11).
 */
async function gatewayOf(engine: EngineUnderTest, log: CollectedLog): Promise<MadeGateway> {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  const gateway = (await api()).makeGateway({
    setting: engine.engine,
    mode: 'process',
    // `panel`, not the default group: a second gateway in the same host must not
    // move the editor layout the other suites are looking at.
    location: 'panel',
    extensionPath: extension.extensionPath,
    editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
    // The default: this suite is not about the channel to the other extension.
    ideChannel: false,
    logger: log,
  });
  assert.equal(
    gateway.engine,
    engine.engine,
    `asked for the ${engine.engine} engine and got ${gateway.engine}: ${log.lines.join(' | ')}`
  );
  return gateway;
}

for (const engine of ENGINES) {
  suite(`TerminalGateway contract: ${engine.engine}`, () => {
    const log = new CollectedLog();

    test('names the engine it is, because the record repeats this and not a setting', async () => {
      const gateway = await gatewayOf(engine, log);
      try {
        assert.equal(gateway.engine, engine.engine);
      } finally {
        gateway.dispose();
      }
    });

    test('is disposed twice without taking the window with it', async () => {
      /*
       * A real crash, and the reason this is in the CONTRACT rather than beside
       * one adapter: both engines are disposed the same two ways -- a person
       * closing a terminal, and the window going away a moment later -- and
       * nothing anywhere promises those two do not overlap.
       *
       * Measured 2026-08-21, in the live run of the drag suite: the extension
       * host died with `code -1073740940` (`STATUS_HEAP_CORRUPTION`) right after
       * a teardown that disposed a handle and then its gateway. Our own pty was
       * guarded against the SECOND kill by "has it ended yet", and the exit
       * event had not arrived yet, so both reached `kill()` on one `IPty`.
       *
       * The test is what it is because of what failing looks like: not a red
       * line, but a run with no summary at all.
       */
      const gateway = await gatewayOf(engine, log);
      const process0 = exiting(0);
      try {
        const handle = await gateway.create({
          terminalId: idFor('40009'),
          name: `gripterm-double-dispose-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: process0.path,
          shellArgs: process0.args,
        });

        handle.dispose();
        // Immediately, with no wait: the whole point is the gap before the exit
        // event arrives, which is where the second kill used to land.
        gateway.dispose();
        handle.dispose();

        await waitFor('the terminal to be forgotten', () => gateway.listKnown().length === 0);
      } finally {
        gateway.dispose();
      }
    });

    test('creates a terminal it then lists and can be asked for by id', async () => {
      const gateway = await gatewayOf(engine, log);
      const terminalId = idFor('40001');
      const process0 = exiting(0);
      try {
        const handle = await gateway.create({
          terminalId,
          name: `gripterm-contract-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: process0.path,
          shellArgs: process0.args,
        });

        assert.equal(gateway.listKnown().length, 1);
        assert.equal(gateway.handleFor(terminalId), handle);

        // Read INSIDE the close listener, deliberately. A terminal has to be
        // forgotten before the listeners run: what the attention notifier does on
        // this event is ask `listKnown()` whether there is still a terminal to
        // show, and an answer that was true a moment ago is the wrong one.
        let knownAtClose = -1;
        const during = handle.onDidClose(() => {
          knownAtClose = gateway.listKnown().length;
        });

        await closeOf(handle);
        during.dispose();
        assert.equal(knownAtClose, 0, 'a terminal was still listed while its close was being announced');
        assert.equal(gateway.listKnown().length, 0, 'a closed terminal is still listed');
        assert.equal(gateway.handleFor(terminalId), undefined, 'a closed terminal still has a handle');
      } finally {
        gateway.dispose();
      }
    });

    test('carries the exit code of a process that ended by itself', async () => {
      const gateway = await gatewayOf(engine, log);
      const process3 = exiting(3);
      try {
        const handle = await gateway.create({
          terminalId: idFor('40002'),
          name: `gripterm-contract-exit-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: process3.path,
          shellArgs: process3.args,
        });

        const exit = await closeOf(handle);
        assert.equal(exit.code, 3, 'the code a failed launch is recognised by is gone');
        // The REASON is engine-specific on purpose: measured A29, a process
        // exiting by itself in the editor area arrives as `user`, because what
        // the platform saw was a tab closing; a pty of ours reports `process`.
        // Both mean "nobody asked for this", and no rule reads them apart.
        assert.ok(
          ['process', 'user'].includes(exit.reason),
          `a self-exit was reported as ${exit.reason}`
        );
      } finally {
        gateway.dispose();
      }
    });

    test('reports our own dispose as the extension closing it, with no code', async () => {
      const gateway = await gatewayOf(engine, log);
      const stays = lingering();
      try {
        const handle = await gateway.create({
          terminalId: idFor('40003'),
          name: `gripterm-contract-dispose-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: stays.path,
          shellArgs: stays.args,
        });

        const closed = closeOf(handle);
        handle.dispose();
        const exit = await closed;
        // A15, and the measurement behind `exitVerdict`: the number a killed
        // program exits with is a fact about the program (`claude` 1, `cmd`
        // -1073741510), so passing it through would report a failed launch for
        // every terminal a person closes while it is still starting.
        assert.equal(exit.code, undefined, 'a code we cannot read was reported anyway');
        assert.equal(exit.reason, 'extension');
      } finally {
        gateway.dispose();
      }
    });

    test('names the process it started, and it is that process and not a console host', async () => {
      const gateway = await gatewayOf(engine, log);
      const stays = lingering();
      try {
        const handle = await gateway.create({
          terminalId: idFor('40004'),
          name: `gripterm-contract-pid-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: stays.path,
          shellArgs: stays.args,
        });

        const pid = await handle.processId();
        assert.ok(pid !== null && pid > 0, 'no pid, which is a record no window can restore');
        const image = imageNameOf(pid).toLowerCase();
        // Under ConPTY the console host is a process too, and its pid would pass
        // every test that only asked for a number while breaking restoration on a
        // real machine (measured, M3.2(8)).
        assert.ok(
          image.includes('cmd.exe') || image.includes('sh'),
          `pid ${String(pid)} belongs to ${image.trim()}, not to the process we asked for`
        );

        const closed = closeOf(handle);
        handle.dispose();
        await closed;
      } finally {
        gateway.dispose();
      }
    });

    test('types bytes into the process, and appends the newline only when told to execute', async () => {
      const gateway = await gatewayOf(engine, log);
      const stamp = `${engine.engine}-${String(process.pid)}`;
      const script = join(os.tmpdir(), `gripterm-stdin-${stamp}.js`);
      const dump = join(os.tmpdir(), `gripterm-stdin-${stamp}.txt`);
      const ready = join(os.tmpdir(), `gripterm-stdin-${stamp}.ready`);
      /*
       * Every chunk is recorded as it arrives, JSON-escaped, rather than
       * accumulated. Accumulating would make the two halves of `execute`
       * indistinguishable: a process that exits on the first newline sees the
       * same final text whether the newline came with the first call or the
       * second. Raw mode because that is what a caller of `sendText` is talking
       * to -- a line discipline would hold everything back until Enter.
       */
      await writeFile(
        script,
        'const fs = require("fs");\n' +
          'const dump = process.argv[3];\n' +
          'fs.writeFileSync(dump, "");\n' +
          'if (process.stdin.isTTY) { process.stdin.setRawMode(true); }\n' +
          'process.stdin.on("data", (chunk) => {\n' +
          '  fs.appendFileSync(dump, JSON.stringify(String(chunk)) + "\\n");\n' +
          '  if (String(chunk).includes("X")) { process.exit(0); }\n' +
          '});\n' +
          'process.stdin.resume();\n' +
          'fs.writeFileSync(process.argv[2], "listening");\n',
        'utf8'
      );
      await rm(dump, { force: true });
      await rm(ready, { force: true });

      try {
        const handle = await gateway.create({
          terminalId: idFor('40005'),
          name: `gripterm-contract-stdin-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: nodePath(),
          shellArgs: [script, ready, dump],
        });
        const closed = closeOf(handle);
        await waitFor('the process to start reading its input', () => existsSync(ready));

        let seen = '';
        handle.sendText('alpha', false);
        await waitFor('the text sent without execute to arrive', async () => {
          seen = await readFile(dump, 'utf8');
          return seen.includes('alpha');
        });
        assert.ok(
          !seen.includes('\\r') && !seen.includes('\\n'),
          `execute was not asked for and a newline arrived anyway: ${seen}`
        );

        handle.sendText('beta', true);
        await waitFor('the text sent with execute to arrive', async () => {
          seen = await readFile(dump, 'utf8');
          return seen.includes('beta');
        });
        assert.ok(seen.includes('\\r'), `execute was asked for and no newline arrived: ${seen}`);

        handle.sendText('X', true);
        await closed;
      } finally {
        gateway.dispose();
        await rm(dump, { force: true });
        await rm(ready, { force: true });
        await rm(script, { force: true });
      }
    });

    test('takes showing and renaming without failing, whether or not it has anywhere to put them', async () => {
      const gateway = await gatewayOf(engine, log);
      const stays = lingering();
      try {
        const handle = await gateway.create({
          terminalId: idFor('40006'),
          name: `gripterm-contract-show-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: stays.path,
          shellArgs: stays.args,
        });

        // Both members return nothing and promise nothing about WHEN they land
        // (§4.1). Under `editor` a rename waits for the person to look at that
        // terminal; under `own` the strip of tabs that would carry it arrives in
        // M3.6. What the contract holds either engine to is that neither call
        // throws out of a caller who has nobody to tell.
        handle.show(true);
        handle.show(false);
        handle.rename(`gripterm-renamed-${engine.engine}`);

        const closed = closeOf(handle);
        handle.dispose();
        await closed;
      } finally {
        gateway.dispose();
      }
    });

    test('has the screen its engine is supposed to have, and only then', async () => {
      const gateway = await gatewayOf(engine, log);
      const stays = lingering();
      try {
        const handle = await gateway.create({
          terminalId: idFor('40007'),
          name: `gripterm-contract-screen-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: stays.path,
          shellArgs: stays.args,
        });

        // A line of the contract and not something a caller finds out: there is
        // no `onDidWriteTerminalData` in the stable API, so the editor's engine
        // cannot have bytes at all, and every reader of `screen` starts by
        // handling the terminal it cannot see inside.
        assert.equal(
          handle.screen === undefined,
          !engine.hasScreen,
          `screen presence is wrong for the ${engine.engine} engine`
        );

        const closed = closeOf(handle);
        handle.dispose();
        await closed;
      } finally {
        gateway.dispose();
      }
    });

    test('has every member of the port, including the one whose behaviour is out of the contract', async () => {
      const gateway = await gatewayOf(engine, log);
      const process0 = exiting(0);
      try {
        const handle = await gateway.create({
          terminalId: idFor('40008'),
          name: `gripterm-contract-members-${engine.engine}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: process0.path,
          shellArgs: process0.args,
        });

        for (const member of OUT_OF_CONTRACT) {
          assert.equal(
            typeof handle[member],
            'function',
            `${member} is excluded from the contract, not from the port`
          );
        }

        await closeOf(handle);
      } finally {
        gateway.dispose();
      }
    });
  });
}
