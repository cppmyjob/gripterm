import * as assert from 'node:assert/strict';
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

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
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
});
