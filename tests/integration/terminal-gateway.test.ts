import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The domain types are derived from the extension's own API rather than
 * imported from `@gripterm/core` directly. The two spellings resolve to
 * different declaration files -- `packages/core/src` here against
 * `packages/core/dist` there -- and the nominal brand on `TerminalId` makes
 * them incompatible, which is the brand doing its job.
 */
type Handle = Awaited<ReturnType<GriptermApi['gateway']['create']>>;
type Spec = Parameters<GriptermApi['gateway']['create']>[0];
type Exit = Parameters<Parameters<Handle['onDidClose']>[0]>[0];

/**
 * The gateway against a real editor, which is the only place it can be checked
 * at all: `createTerminal`, the window-level close event and `exitStatus.code`
 * are the platform's, and a fake would be free to invent any of them.
 *
 * Deliberately does NOT run `claude`. What is under test is the adapter, and a
 * process that exits with a code we chose gives a sharper assertion than a TUI
 * would -- while keeping the suite runnable on a machine with no CLI installed.
 */

/** The gateway keys on `.value` alone; the brand exists to stop this happening anywhere but a test. */
const TERMINAL_ID = { value: '550e8400-e29b-41d4-a716-446655440000' } as unknown as Spec['terminalId'];

/** A process that exits with the code we ask for, without a shell profile in the way. */
function exiting(code: number): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', `exit ${code}`] }
    : { path: '/bin/sh', args: ['-c', `exit ${code}`] };
}

/** A process that stays up until the terminal is disposed, so its pid can be asked about. */
function lingering(): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'pause'] }
    : { path: '/bin/sh', args: ['-c', 'read line'] };
}

/** The node the forwarder is run with, and a process that reports its own environment. */
function nodePath(): string {
  const found = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/u)[0];
  return found === undefined ? 'node' : found.trim();
}

/** What the operating system calls the process behind a pid. The check that the number is the right one. */
function imageNameOf(pid: number): string {
  return process.platform === 'win32'
    ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** Waits for something the editor does on its own schedule, or gives up saying what it wanted. */
async function waitFor(what: string, ready: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The tabs of every editor group, which is where a terminal-in-the-editor appears. */
function terminalTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTerminal);
}

/** Resolves with the exit the gateway reported, or rejects if the terminal outlives the wait. */
async function closeOf(handle: Handle, ms = 20000): Promise<Exit> {
  return await new Promise<Exit>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`the terminal did not close within ${ms} ms`));
    }, ms);
    const subscription = handle.onDidClose((exit) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(exit);
    });
  });
}

suite('VsCodeTerminalGateway', () => {
  test('creates a terminal the editor knows about', async () => {
    const { gateway } = await api();
    const process0 = exiting(0);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-integration',
      cwd: os.tmpdir(),
      env: { GRIPTERM_INTEGRATION: '1' },
      shellPath: process0.path,
      shellArgs: process0.args,
    });

    assert.ok(
      vscode.window.terminals.some((terminal) => terminal.name === 'gripterm-integration'),
      'the editor does not list a terminal we just created'
    );
    assert.equal(gateway.listKnown().length, 1);

    await closeOf(handle);
  });

  test('carries the process exit code through the port', async () => {
    // The number is what separates a failed launch from a deliberate close
    // (M1.12). A boolean here would make `launch_failed` unreachable.
    const { gateway } = await api();
    const process3 = exiting(3);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-exit-3',
      cwd: os.tmpdir(),
      env: {},
      shellPath: process3.path,
      shellArgs: process3.args,
    });

    const exit = await closeOf(handle);
    assert.equal(exit.code, 3);
  });

  test('names the process the editor started, which is the whole of the pid channel', async () => {
    /*
     * M2.16, and the defect its acceptance run found: nothing wrote a pid onto
     * a record, so the restore predicate read every one of them as "may still
     * be running" and brought nothing back.
     *
     * Checked against the operating system rather than against a non-zero
     * number: what matters is that `Terminal.processId` is the process we ASKED
     * for and not a console host or a helper standing in front of it, because
     * the question every window asks of that number is "is this conversation
     * still running".
     */
    const { gateway } = await api();
    const waiting = lingering();

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-pid',
      cwd: os.tmpdir(),
      env: {},
      shellPath: waiting.path,
      shellArgs: waiting.args,
    });

    try {
      const pid = await handle.processId();
      assert.ok(pid !== null && pid > 0, `the editor named no process: ${String(pid)}`);
      assert.match(imageNameOf(pid), /cmd\.exe/iu);
    } finally {
      handle.dispose();
      await closeOf(handle);
    }
  });

  test('takes a variable away when the spec says null, and not merely blanks it', async () => {
    /*
     * The platform half of A28. Our launch removes the markers of another Claude
     * Code run from the terminal environment (`INHERITED_FROM_ANOTHER_RUN`), and
     * the whole of that fix rests on the editor honouring `null` in
     * `TerminalOptions.env` as "unset". An empty string would not do: the CLI
     * reads presence, not value.
     *
     * `NUMBER_OF_PROCESSORS` stands in for a marker here -- it is always in a
     * Windows environment, it belongs to nobody, and its absence is unambiguous.
     */
    const { gateway } = await api();
    const dump = join(os.tmpdir(), `gripterm-env-${String(process.pid)}.json`);
    const script = join(os.tmpdir(), `gripterm-env-${String(process.pid)}.js`);
    // A script rather than a redirection: the arguments of a terminal process go
    // to the process, not through a shell, so `>` would be a literal argument.
    await writeFile(script, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.env));', 'utf8');
    await rm(dump, { force: true });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-env',
      cwd: os.tmpdir(),
      env: { GRIPTERM_KEPT: 'yes', NUMBER_OF_PROCESSORS: null },
      shellPath: nodePath(),
      shellArgs: [script, dump],
    });

    try {
      await closeOf(handle);
      const written = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
      assert.equal(written.GRIPTERM_KEPT, 'yes', 'the variable we added is not there');
      assert.equal(
        written.NUMBER_OF_PROCESSORS,
        undefined,
        'the variable we removed is still there'
      );
    } finally {
      await rm(dump, { force: true });
      await rm(script, { force: true });
    }
  });

  test('forgets a terminal once it has closed', async () => {
    const { gateway } = await api();
    const process0 = exiting(0);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-forget',
      cwd: os.tmpdir(),
      env: {},
      shellPath: process0.path,
      shellArgs: process0.args,
    });

    await closeOf(handle);
    assert.equal(gateway.listKnown().length, 0, 'a closed terminal is still listed as known');
  });

  /**
   * A15, open since M1.5 and unanswerable without a live editor: does the
   * platform raise `onDidCloseTerminal` for a terminal the EXTENSION disposed,
   * and with what `exitStatus.code`?
   *
   * The answer decides M1.12: `closeTerminal` is the only producer of
   * `closedAt`, and if the platform stays silent there, the lifecycle service
   * has to emit `TerminalClosed` itself instead of waiting for an event that
   * never comes.
   */
  /**
   * A21, opened when the owner asked for the panel's furniture to go away: does
   * a terminal opened in the EDITOR area behave like the one in the panel?
   *
   * Everything M1 rests on -- A3 (`isTransient`), A15 (our own dispose raises
   * the close event) -- was measured on panel terminals. The mechanism is also
   * the one the roadmap names for the workflow view of M5 ("2 таба"): a canvas
   * webview BESIDE the terminal, which a terminal living in the panel has no
   * room for.
   */
  test('A21: a terminal opens as an editor tab, not in the panel', async () => {
    const { gateway, readiness } = await api();
    assert.equal(readiness.location, 'editor', 'the default is no longer the editor area');
    // By NAME rather than by count. Earlier tests in this file open and close
    // terminals of their own, and the editor tears their tabs down on its own
    // schedule -- so a count taken here can fall as easily as it rises, and an
    // assertion on it fails for a reason that has nothing to do with A21.
    assert.ok(
      !terminalTabs().some((tab) => tab.label.includes('gripterm-a21')),
      'a tab from an earlier run is still open, so this test would prove nothing'
    );

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-a21',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    handle.show(false);

    await waitFor('a terminal tab in the editor area', () =>
      terminalTabs().some((tab) => tab.label.includes('gripterm-a21'))
    );

    const closed = closeOf(handle);
    handle.dispose();
    // The same answer as A15 gave for the panel: `undefined`, because nothing
    // exited on its own. Measured here rather than assumed to carry over.
    assert.equal((await closed).code, undefined);
    await waitFor('the tab to go with the terminal', () =>
      terminalTabs().every((tab) => !tab.label.includes('gripterm-a21'))
    );
  });

  test('A15: disposing our own terminal still reports a close', async () => {
    const { gateway } = await api();

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-a15',
      cwd: os.tmpdir(),
      env: {},
      // A shell that sits there: the close under test is ours, not the
      // process's, so the process must not race us to it.
      shellPath: null,
      shellArgs: [],
    });

    const closed = closeOf(handle);
    handle.dispose();
    const exit = await closed;

    // Measured 2026-08-11, VS Code 1.132.0 on win32 -- see the assertion, which
    // is the record. `undefined` means the platform reports our own dispose the
    // same way it reports a person closing the terminal: there is no exit code,
    // because nothing exited on its own.
    assert.equal(exit.code, undefined);
  });

  /**
   * A29, opened by the owner on 2026-08-13: a terminal closed with the tab's
   * cross comes back at the next reload, because nothing on that path sets
   * `closedAt`.
   *
   * A15 is the reason it was written that way, and A15 is true: the exit CODE
   * cannot tell a deliberate close from the editor killing a transient terminal
   * at shutdown -- both are `undefined`. What was never checked is that
   * `exitStatus` carries a second field. `TerminalExitReason` is in the API this
   * extension is built against (1.94) and separates all four cases by name, so
   * "the platform cannot tell us" was a claim about a field nobody read.
   *
   * Three of the four are measurable from inside a running host and are measured
   * here. `shutdown` is the fourth and cannot be, because it happens while this
   * process is being taken down: measured instead on 2026-08-13 with a
   * throwaway extension in a real window, which created two transient terminals,
   * asked for a RELOAD, and then asked the window to close. Both times, in the
   * panel and in the editor area alike, the answer was `Shutdown` with no exit
   * code. That is the row the rule leans on, and it is why a reload does not
   * empty the base.
   *
   * The reading that changed the rule is the one below about a process exiting:
   * in the EDITOR AREA the platform reports that as `user` as well, because what
   * it sees is the tab closing. So `user` is not intent by itself, and the pair
   * -- `user` with nothing exited -- is what `_noteDeliberateClose` reads.
   */
  test('A29: our own dispose is reported as an extension close', async () => {
    const { gateway } = await api();

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-a29-extension',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    const closed = closeOf(handle);
    handle.dispose();
    const exit = await closed;

    // The half of A29 that decides whether the rule is safe at all: our own
    // `close` command already sets `closedAt` before it disposes, so this must
    // NOT be the same answer the person's own close gives -- or the two acts
    // would be one, and there would be nothing measured about either.
    assert.equal(exit.reason, 'extension');
  });

  test('A29: a process exiting in the editor area is reported as a user close, with its code', async () => {
    const { gateway, readiness } = await api();
    // The whole point of this assertion is WHERE it runs. In the panel the same
    // exit is reported as `process`; in the editor area, which is what this
    // build opens terminals in, the platform sees a tab closing and says `user`.
    assert.equal(readiness.location, 'editor');
    const process0 = exiting(0);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-a29-process',
      cwd: os.tmpdir(),
      env: {},
      shellPath: process0.path,
      shellArgs: process0.args,
    });

    const exit = await closeOf(handle);

    // The reading that refuted the first version of this rule. A `claude` that
    // fell over, or that a person ended with `/exit`, arrives wearing the same
    // reason as the cross on the tab -- and is told apart by the code, which a
    // close nobody exited out of does not have.
    assert.equal(exit.reason, 'user');
    assert.equal(exit.code, 0);
  });

  test('A29: the person closing the terminal tab is reported as a user close', async () => {
    const { gateway } = await api();
    const terminals = vscode.workspace.getConfiguration('terminal.integrated');
    // The dialog the owner described -- "terminate the running process?" -- is
    // this setting, and a modal in a headless run is a suite that hangs rather
    // than a suite that fails. Turned off for the measurement and put back
    // afterwards: what is under test is the REASON the platform reports, and the
    // confirmation is upstream of it.
    const confirmOnKill = terminals.get<string>('confirmOnKill');
    await terminals.update('confirmOnKill', 'never', vscode.ConfigurationTarget.Global);

    try {
      const handle = await gateway.create({
        terminalId: TERMINAL_ID,
        name: 'gripterm-a29-user',
        cwd: os.tmpdir(),
        env: {},
        // Nothing that can exit by itself and win the race to the close event.
        shellPath: null,
        shellArgs: [],
      });
      handle.show(false);
      await waitFor('the terminal tab to appear', () =>
        terminalTabs().some((tab) => tab.label.includes('gripterm-a29-user'))
      );

      const closed = closeOf(handle);
      const tab = terminalTabs().find((one) => one.label.includes('gripterm-a29-user'));
      assert.ok(tab, 'the tab went before it could be closed');
      // The API spelling of the cross on the tab, which is the act the owner
      // reported. Not `workbench.action.terminal.kill`: that is the context
      // menu's "Kill Terminal", a different call site, and a rule measured on
      // one and applied to the other is a rule measured on neither.
      await vscode.window.tabGroups.close(tab);

      assert.equal((await closed).reason, 'user');
    } finally {
      await terminals.update(
        'confirmOnKill',
        confirmOnKill,
        vscode.ConfigurationTarget.Global
      );
    }
  });
});
