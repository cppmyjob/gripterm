import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * Renaming the tab of a terminal we created, against a real editor -- which is
 * the only place it can be checked, and the reason this file exists at all.
 *
 * Until M2.17 this build stated the opposite in `TerminalMetadataService`: that
 * the platform offers no way to rename a terminal after it is created. That was
 * read off the API surface, where it is true -- `Terminal.name` is read-only --
 * and never measured against the editor's own commands, where it is false. What
 * is used instead is `workbench.action.terminal.renameWithArg`, which is a
 * command and not an API: it can be removed in any release, so its behaviour is
 * asserted here rather than assumed anywhere.
 */

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const FIRST_ID = { value: 'b7c1a8e4-3d2f-4a1b-9c8d-7e6f5a4b3c2d' } as unknown as Spec['terminalId'];
const SECOND_ID = { value: 'c8d2b9f5-4e3a-4b2c-8d9e-6f5a4b3c2d1e' } as unknown as Spec['terminalId'];

/** A process that stays up, so the terminal is there to be renamed. */
function lingering(): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'pause'] }
    : { path: '/bin/sh', args: ['-c', 'read line'] };
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function waitFor(what: string, ready: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Closes what a test made and WAITS for the editor to agree that it is gone.
 *
 * Not politeness: a terminal disposed of is still a tab for a moment, and the
 * next suite in this host counts the tabs it can see. A test that left one
 * behind would fail a test in another file, which is the worst kind of red.
 */
async function closeAll(terminals: readonly vscode.Terminal[]): Promise<void> {
  for (const terminal of terminals) {
    terminal.dispose();
  }
  await waitFor(
    'the terminals of this test to go',
    () => terminals.every((one) => !vscode.window.terminals.includes(one)),
    10_000
  );
}

/** The editor's own object for a terminal we made, found by the name it was given. */
function terminalNamed(name: string): vscode.Terminal {
  const found = vscode.window.terminals.find((one) => one.name === name);
  assert.ok(found, `the editor has no terminal called ${name}`);
  return found;
}

suite('renaming the tab of a terminal', () => {
  test('the tab takes the new name while the person is looking at it', async () => {
    const { gateway } = await api();
    const shell = lingering();
    const handle = await gateway.create({
      terminalId: FIRST_ID,
      name: 'gripterm-rename-before',
      cwd: os.tmpdir(),
      env: {},
      shellPath: shell.path,
      shellArgs: shell.args,
    });

    const terminal = terminalNamed('gripterm-rename-before');
    try {
      handle.show(true);
      await waitFor('the terminal to become the active one', () => vscode.window.activeTerminal === terminal);

      handle.rename('gripterm-rename-after');

      // `Terminal.name` is updated from the renderer through
      // `$acceptTerminalTitleChange`, so the extension host sees the new name on
      // the same object -- which is how a tab can be checked without eyes.
      await waitFor('the tab to take the new name', () => terminal.name === 'gripterm-rename-after');
    } finally {
      await closeAll([terminal]);
    }
  });

  test('a rename waits for a terminal nobody is looking at, and lands when they turn to it', async () => {
    const { gateway } = await api();
    const shell = lingering();
    const first = await gateway.create({
      terminalId: FIRST_ID,
      name: 'gripterm-waiting-before',
      cwd: os.tmpdir(),
      env: {},
      shellPath: shell.path,
      shellArgs: shell.args,
    });
    const second = await gateway.create({
      terminalId: SECOND_ID,
      name: 'gripterm-elsewhere',
      cwd: os.tmpdir(),
      env: {},
      shellPath: shell.path,
      shellArgs: shell.args,
    });

    const waiting = terminalNamed('gripterm-waiting-before');
    const elsewhere = terminalNamed('gripterm-elsewhere');
    try {
      second.show(true);
      await waitFor('the other terminal to be the active one', () => vscode.window.activeTerminal === elsewhere);

      first.rename('gripterm-waiting-after');

      // Nothing moves: the editor renames the ACTIVE terminal, and making this
      // one active would pull the panel out from under the person for a change
      // they did not ask for.
      await sleep(1000);
      assert.equal(waiting.name, 'gripterm-waiting-before');
      assert.equal(vscode.window.activeTerminal, elsewhere, 'the rename stole the person\'s terminal');

      first.show(true);
      await waitFor('the held name to land', () => waiting.name === 'gripterm-waiting-after');
    } finally {
      await closeAll([waiting, elsewhere]);
    }
  });
});
