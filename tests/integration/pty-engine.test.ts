import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PtyTerminalHandle } from '../../packages/extension/src/adapters/pty-terminal-gateway';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * What belongs to the `own` engine alone: the environment it hands the agent, the
 * bytes it can see, and the fallback that has to be audible.
 *
 * The shared half is in `terminal-gateway-contract.test.ts` -- one suite over both
 * engines. Here is everything that is true of a pty of ours and of nothing the
 * editor makes, plus the two paths a person actually meets: the engine they asked
 * for, and the engine they get when the addon is not there.
 *
 * Every gateway comes from the extension's own factory, so what is under test is
 * the code the window runs rather than a second copy of it compiled beside it.
 */

type Gateway = GriptermApi['gateway'];
type MadeGateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];

/**
 * The markers of the Claude Code run that started the editor, spelled out here.
 *
 * A second copy of a list that lives in `LaunchCommandBuilder`, and it is a copy
 * on purpose: the compiled integration suite cannot import `@gripterm/core` at
 * runtime -- it resolves through `node_modules`, which an installed extension has
 * none of -- and the alternative was to export the domain's list for a test to
 * read. What keeps the two honest is not this file: it is
 * `launch-command-builder.test.ts`, which asserts that the builder marks exactly
 * nine names for removal and that none of them survives `terminalEnvironment`.
 * What THIS file adds is the part no unit test can reach: that the removal
 * survives a real spawn, with every one of the nine present in the host.
 */
const CLAUDE_RUN_MARKERS: readonly string[] = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PROJECT_DIR',
];

/** The editor's own, measured present in the extension host and absent from its terminals (M3.2 §5.1). */
const EDITOR_INTERNALS: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
  'VSCODE_CWD',
  'VSCODE_ESM_ENTRYPOINT',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS',
  'VSCODE_IPC_HOOK',
  'VSCODE_L10N_BUNDLE_LOCATION',
  'VSCODE_NLS_CONFIG',
  'VSCODE_PID',
];

/** A name planted in the host so the test can tell "carried through" from "invented". */
const CARRIED = 'GRIPTERM_HOST_CARRIED';

function idFor(suffix: string): Spec['terminalId'] {
  return { value: `550e8400-e29b-41d4-a716-4466553${suffix}` } as unknown as Spec['terminalId'];
}

function nodePath(): string {
  const found = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/u)[0];
  return found === undefined ? 'node' : found.trim();
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

  public said(fragment: string): boolean {
    return this.lines.some((line) => line.includes(fragment));
  }
}

function extensionPath(): string {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return extension.extensionPath;
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** The engine choice, made the way the window makes it. `where` is the extension directory. */
async function gatewayFor(
  setting: 'editor' | 'own',
  mode: 'process' | 'shell',
  where: string,
  log: CollectedLog
): Promise<MadeGateway> {
  return (await api()).makeGateway({
    setting,
    mode,
    location: 'panel',
    extensionPath: where,
    editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
    logger: log,
  });
}

async function ownGateway(log: CollectedLog): Promise<MadeGateway> {
  const gateway = await gatewayFor('own', 'process', extensionPath(), log);
  // Not a skip: `build:extension` makes the copy, and the integration run
  // performs that build, so anything else here is a broken build.
  assert.equal(gateway.engine, 'own', `the own engine did not come up: ${log.lines.join(' | ')}`);
  return gateway;
}

async function closeOf(handle: Handle, ms = 20000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`the terminal did not close within ${String(ms)} ms`));
    }, ms);
    const subscription = handle.onDidClose(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
  });
}

/** Waits for something on somebody else's schedule, or gives up saying what it wanted. */
async function waitFor(what: string, ready: () => boolean, ms = 20000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A script that writes its own environment where the test can read it. */
async function environmentDump(stamp: string): Promise<{ readonly script: string, readonly dump: string }> {
  const script = join(os.tmpdir(), `gripterm-own-env-${stamp}.js`);
  const dump = join(os.tmpdir(), `gripterm-own-env-${stamp}.json`);
  await writeFile(
    script,
    'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.env));',
    'utf8'
  );
  await rm(dump, { force: true });
  return { script, dump };
}

suite('the own engine: the environment it hands the agent', () => {
  test('carries none of the markers of the Claude Code run that started the editor, with all nine in the host', async () => {
    /*
     * A28, and the reason the delta cannot simply be spread over `process.env`.
     * `{...process.env, ...spec.env}` gives the CLI `CLAUDE_CODE_CHILD_SESSION`
     * holding the STRING "null", and with that variable present in any form the
     * CLI writes no transcript and no history line at all -- so the conversation
     * cannot be resumed by us or by anybody, and nothing says so.
     *
     * The host is given all nine on purpose: a machine where they are absent
     * would pass this test with the rule deleted.
     */
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    const { script, dump } = await environmentDump(`markers-${String(process.pid)}`);
    const delta: Record<string, string | null> = {};
    for (const marker of CLAUDE_RUN_MARKERS) {
      process.env[marker] = `set-by-the-test-${marker}`;
      delta[marker] = null;
    }

    try {
      const handle = await gateway.create({
        terminalId: idFor('0001'),
        name: 'gripterm-own-markers',
        cwd: os.tmpdir(),
        env: delta,
        shellPath: nodePath(),
        shellArgs: [script, dump],
      });
      await closeOf(handle);

      const written = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
      for (const marker of CLAUDE_RUN_MARKERS) {
        assert.equal(
          written[marker],
          undefined,
          `${marker} reached the agent as ${JSON.stringify(written[marker])}`
        );
      }
    } finally {
      for (const marker of CLAUDE_RUN_MARKERS) {
        // The host's environment is put back exactly as it was found. `delete` by
        // a computed key, spelled the way the linter accepts.
        Reflect.deleteProperty(process.env, marker);
      }
      gateway.dispose();
      await rm(dump, { force: true });
      await rm(script, { force: true });
    }
  });

  test('takes the editor internals off, puts the editor identity on, and carries the rest through', async () => {
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    const { script, dump } = await environmentDump(`identity-${String(process.pid)}`);
    // The extension host really does have these -- measured M3.2 stage B §5.1 --
    // so this half is not hypothetical. Asserted rather than assumed: a host
    // without them would make the removals unobservable.
    assert.notEqual(process.env.VSCODE_PID, undefined, 'the host has no VSCODE_PID to remove');
    assert.notEqual(
      process.env.NUMBER_OF_PROCESSORS,
      undefined,
      'the host has no NUMBER_OF_PROCESSORS for the delta to remove'
    );
    process.env[CARRIED] = 'from-the-host';

    try {
      const handle = await gateway.create({
        terminalId: idFor('0002'),
        name: 'gripterm-own-identity',
        cwd: os.tmpdir(),
        env: { GRIPTERM_KEPT: 'yes', NUMBER_OF_PROCESSORS: null },
        shellPath: nodePath(),
        shellArgs: [script, dump],
      });
      await closeOf(handle);

      const written = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
      for (const name of EDITOR_INTERNALS) {
        assert.equal(written[name], undefined, `${name} reached the agent`);
      }
      // The host's own environment is the base, not something the rule invents:
      // without this, a rule that started from an empty object would pass every
      // assertion above.
      assert.equal(written[CARRIED], 'from-the-host', 'the host environment was not carried through');
      assert.equal(written.TERM_PROGRAM, 'vscode', 'the CLI cannot tell it is inside an editor');
      assert.equal(written.TERM_PROGRAM_VERSION, vscode.version);
      assert.equal(written.COLORTERM, 'truecolor');
      // node-pty writes TERM itself, out of the `name` option (`env.TERM =
      // opt.name || env.TERM || 'xterm'`, in both terminals of 1.1.0), so the
      // choice is which value and not whether.
      assert.equal(written.TERM, 'xterm-256color');
      assert.equal(written.GRIPTERM_KEPT, 'yes', 'the delta did not reach the process');
      assert.equal(
        written.NUMBER_OF_PROCESSORS,
        undefined,
        'a variable the delta removed is still there'
      );
    } finally {
      Reflect.deleteProperty(process.env, CARRIED);
      gateway.dispose();
      await rm(dump, { force: true });
      await rm(script, { force: true });
    }
  });
});

suite('the own engine: the bytes it can see', () => {
  test('gives the screen what the process prints, takes what is written to it, and ends once', async () => {
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    try {
      const handle = await gateway.create({
        terminalId: idFor('0003'),
        name: 'gripterm-own-screen',
        cwd: os.tmpdir(),
        env: {},
        shellPath: nodePath(),
        shellArgs: [
          '-e',
          'if (process.stdin.isTTY) { process.stdin.setRawMode(true); }\n' +
            'process.stdin.on("data", (chunk) => { if (String(chunk).includes("q")) { process.exit(7); } });\n' +
            'process.stdin.resume();\n' +
            'process.stdout.write("screen-up\\n");',
        ],
      });

      const { screen } = handle;
      assert.ok(screen, 'the own engine has no screen');

      let seen = '';
      const data = screen.onData((chunk) => {
        seen += chunk;
      });
      let exits = 0;
      let code: number | undefined;
      screen.onExit((exit) => {
        exits += 1;
        code = exit.code;
      });

      await waitFor('the process to print something', () => seen.includes('screen-up'));

      // Resizing is legal at any moment, including one where the process is
      // already gone: node-pty throws `Cannot resize a pty that has already
      // exited`, and no caller can avoid that by asking first (§8).
      screen.resize(100, 40);

      /*
       * A size that is not one is refused HERE, before the native call, and the
       * refusal is a sentence of its own rather than the one about a terminal
       * that has ended. Measured 2026-08-17 against node-pty 1.1.0 through this
       * very copy: `NaN`, `0` and `-5` all throw `resizing must be done using
       * positive cols and rows`, while `10.5` is accepted silently. The one that
       * matters is `NaN` -- `FitAddon` proposes it for a terminal hidden with
       * `display: none` (xterm.js#3029), which is the shape M3.9 will be putting
       * terminals into.
       */
      screen.resize(Number.NaN, 40);
      assert.ok(
        log.said('a size that is not one'),
        `an impossible size was not refused in its own words: ${log.lines.join(' | ')}`
      );

      const closed = closeOf(handle);
      screen.write('q');
      await closed;
      // The end of a pty reaches an adapter from more than one direction; a
      // record written twice is two deaths for one dying.
      await waitFor('the screen to report the exit', () => exits > 0);
      assert.equal(exits, 1);
      assert.equal(code, 7, 'the screen lost the code the process exited with');
      data.dispose();

      // Ignored rather than thrown out of, both of them, after the end.
      screen.write('nobody is listening');
      screen.resize(10, 10);
      screen.dispose();
      screen.dispose();
    } finally {
      gateway.dispose();
    }
  });
});

suite('the own engine: what it keeps until there is somewhere to put it', () => {
  test('holds the name and the last request to be shown, because the strip of tabs arrives in M3.6', async () => {
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    try {
      const handle = (await gateway.create({
        terminalId: idFor('0004'),
        name: 'gripterm-own-name',
        cwd: os.tmpdir(),
        env: {},
        shellPath: nodePath(),
        shellArgs: ['-e', 'setInterval(() => {}, 1000);'],
      })) as PtyTerminalHandle;

      assert.equal(handle.name, 'gripterm-own-name');
      assert.equal(handle.shownPreservingFocus, null, 'nobody asked for it to be shown yet');

      handle.rename('gripterm-own-renamed');
      handle.show(true);
      assert.equal(handle.name, 'gripterm-own-renamed');
      assert.equal(handle.shownPreservingFocus, true);
      handle.show(false);
      assert.equal(handle.shownPreservingFocus, false);

      const closed = closeOf(handle);
      handle.dispose();
      await closed;
    } finally {
      gateway.dispose();
    }
  });

  test('refuses the launch line out loud instead of typing it nowhere', async () => {
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    try {
      const handle = await gateway.create({
        terminalId: idFor('0005'),
        name: 'gripterm-own-launch-line',
        cwd: os.tmpdir(),
        env: {},
        shellPath: nodePath(),
        shellArgs: ['-e', 'setInterval(() => {}, 1000);'],
      });

      handle.runLaunchCommand('claude --resume');
      assert.ok(
        log.said('shell'),
        `the refusal never said what it was refusing: ${log.lines.join(' | ')}`
      );

      const closed = closeOf(handle);
      handle.dispose();
      await closed;
    } finally {
      gateway.dispose();
    }
  });

  test('ends its terminals as a window leaving, not as a disposal, when the whole gateway goes', async () => {
    /*
     * The difference П7 stands on (M3.5). The two are one act to a pty and
     * opposite acts to a record: `extension` is a terminal that was ended, while
     * `shutdown` is a window that left -- and only the second leaves the record
     * restorable, because our terminals are transient and every reload closes
     * all of them. Flattened, a reload would stamp `closedAt` on everything and
     * bring nothing back.
     *
     * Asserted here rather than trusted from `exitVerdict`'s own table: what
     * that table cannot say is which CAUSE this path feeds it.
     */
    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    const handle = await gateway.create({
      terminalId: idFor('0007'),
      name: 'gripterm-own-shutdown',
      cwd: os.tmpdir(),
      env: {},
      shellPath: nodePath(),
      shellArgs: ['-e', 'setInterval(() => {}, 1000);'],
    });
    const exits: { readonly code: number | undefined, readonly reason: string }[] = [];
    handle.onDidClose((exit) => {
      exits.push(exit);
    });

    gateway.dispose();
    await waitFor('the terminal to report its end', () => exits.length > 0);

    assert.deepEqual(exits, [{ code: undefined, reason: 'shutdown' }]);
    assert.deepEqual(gateway.listKnown(), [], 'a gateway that let go still lists its terminals');
  });
});

suite('the own engine: the fallback a person has to be able to hear', () => {
  test('falls back to the editor engine when the addon is not where the build puts it, and says so', async () => {
    /*
     * The whole of M3.4(4) in one assertion. The record is stamped from
     * `gateway.engine`, so an engine that lied here would hand reconciliation a
     * live conversation to end -- under `editor` a `claude` outlives the
     * extension host on purpose (M2.16), and a record claiming `own` would make
     * it an orphan to kill.
     *
     * This is also the acceptance line "switching verified on a machine without a
     * built node-pty", reached the way the plan asks for it: by taking the copy
     * away from the engine rather than by breaking the build that makes it.
     */
    const log = new CollectedLog();
    const gateway = await gatewayFor(
      'own',
      'process',
      join(os.tmpdir(), 'gripterm-no-such-extension'),
      log
    );
    try {
      assert.equal(gateway.engine, 'editor');
      assert.ok(
        log.said('editor'),
        `the fallback was silent, and a silent fallback is a suite that runs one engine twice: ${log.lines.join(' | ')}`
      );
    } finally {
      gateway.dispose();
    }
  });

  test('gives the own engine when the addon is there', async () => {
    const log = new CollectedLog();
    const gateway = await gatewayFor('own', 'process', extensionPath(), log);
    try {
      assert.equal(gateway.engine, 'own');
    } finally {
      gateway.dispose();
    }
  });

  test('refuses own together with the shell mode, out loud, and opens on the editor instead', async () => {
    const log = new CollectedLog();
    const gateway = await gatewayFor('own', 'shell', extensionPath(), log);
    try {
      assert.equal(gateway.engine, 'editor');
      assert.ok(
        log.said('gripterm.terminal.engine') && log.said('gripterm.launch.mode'),
        `the refusal named neither setting: ${log.lines.join(' | ')}`
      );
    } finally {
      gateway.dispose();
    }
  });

  test('reports the engine that answered, which is what a suite has to be able to read', async () => {
    /*
     * The CHANNEL first: a window that asked for `own` and fell back looks
     * exactly like a window that asked for `editor`, and without this field a
     * suite claiming to have exercised both engines could not tell which one it
     * got. The record is stamped from the same object, one line of
     * `TerminalLifecycleService`.
     *
     * The VALUE is then read against the setting THIS WINDOW was given, not
     * against a constant, and that is the whole guard of the second run (M3.10).
     * The suite is run twice, once under each engine (`.vscode-test.mjs`), and
     * the run under `own` is worth nothing unless the window really is on `own`:
     * a missing addon and a `shell` launch mode each send the engine back to the
     * editor, and half the suite would then be the editor's run wearing a second
     * label. Both refusals are audible -- see the two tests above -- and this is
     * where a run notices that one of them happened to it.
     */
    const { readiness, gateway } = await api();
    const settings = vscode.workspace.getConfiguration('gripterm');
    assert.equal(readiness.engine, gateway.engine);
    assert.equal(
      readiness.engine,
      settings.get<string>('terminal.engine'),
      `this window is not on the engine it was asked for, and the launch mode it read is '${String(settings.get<string>('launch.mode'))}'`
    );
  });

  test('leaves the editor as what a window with no setting of its own gets', () => {
    /*
     * The manifest's own default, asserted from the manifest. It used to be
     * asserted from the window above, which was the same sentence for as long as
     * there was one run; the second run of M3.10 sets the setting, and a default
     * is a promise about the windows that do NOT.
     */
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension, 'extension not found in the host');
    const manifest = extension.packageJSON as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };

    assert.equal(
      manifest.contributes.configuration.properties['gripterm.terminal.engine']?.default,
      'editor',
      'the default engine moved without the manifest saying so'
    );
  });

  test('leaves the editor engine alone in both launch modes', async () => {
    for (const mode of ['process', 'shell'] as const) {
      const log = new CollectedLog();
      const gateway = await gatewayFor('editor', mode, extensionPath(), log);
      try {
        assert.equal(gateway.engine, 'editor');
        assert.equal(log.lines.length, 0, `nothing was refused and something was said: ${log.lines.join(' | ')}`);
      } finally {
        gateway.dispose();
      }
    }
  });
});

suite('the own engine: a real agent', () => {
  test('starts the CLI this machine has and takes it down again', async () => {
    /*
     * The row's own acceptance, and the rule behind it: a successful `require` of
     * node-pty proves nothing -- measured 2026-08-17, a probe that stopped at
     * `typeof spawn === "function"` reported success on a package whose
     * `build/Release` was missing entirely. Only a running process proves the
     * load, and the process that matters is the one this extension exists for.
     *
     * No prompt is sent, so no turn is spent: what is under test is that the TUI
     * comes up on a pty of ours and goes away when we say so.
     */
    const { readiness } = await api();
    const { cliPath } = readiness;
    assert.notEqual(cliPath, null, 'claude was not found on PATH, and this test is about a real one');

    const log = new CollectedLog();
    const gateway = await ownGateway(log);
    const delta: Record<string, string | null> = {};
    for (const marker of CLAUDE_RUN_MARKERS) {
      delta[marker] = null;
    }
    try {
      const handle = await gateway.create({
        terminalId: idFor('0006'),
        name: 'gripterm-own-claude',
        cwd: os.tmpdir(),
        env: delta,
        shellPath: cliPath ?? '',
        shellArgs: [],
      });

      const { screen } = handle;
      assert.ok(screen, 'the own engine has no screen');
      let seen = '';
      const data = screen.onData((chunk) => {
        seen += chunk;
      });

      // Measured 90-139 ms to first output in a real editor (M3.2), so this
      // ceiling is for a machine under load rather than an expectation.
      await waitFor('the agent to draw something', () => seen.length > 0, 30000);
      const pid = await handle.processId();
      assert.ok(pid !== null && pid > 0, 'the agent has no pid, so no window could restore it');

      const closed = closeOf(handle);
      handle.dispose();
      await closed;
      data.dispose();
    } finally {
      gateway.dispose();
    }
  });
});
