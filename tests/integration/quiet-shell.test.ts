import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const TERMINAL_ID = { value: '550e8400-e29b-41d4-a716-4466554400a1' } as unknown as Spec['terminalId'];

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** A line each command appends, so that the ORDER they ran in is on disk. */
function marker(who: string, file: string): string {
  return `'${who}' | Out-File -Append -Encoding ascii '${file}'`;
}

async function linesOf(file: string, wanted: number, ms: number): Promise<string[]> {
  const until = Date.now() + ms;
  let lines: string[] = [];
  while (lines.length < wanted && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    lines = fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((one) => one.trim().length > 0)
      : [];
  }
  return lines;
}

/**
 * M2.25. In the launch mode where a shell is underneath, the line that starts
 * the agent must come after whatever the environment does to a fresh shell.
 *
 * Measured in this host on 2026-08-14, three runs, before a line of this was
 * written: an extension that types on `onDidOpenTerminal` gets its line in at
 * 20-60 ms, while the shell only announces itself at 5.2-5.7 s and their command
 * runs 277-423 ms after that. A launch typed on creation therefore went FIRST --
 * `["ours", "other"]` -- and their activation ended up typed into the agent
 * rather than the shell, which is exactly what the owner saw.
 *
 * The stand-in below types with no delay at all, which is the worst case for us:
 * nothing here knows or names which extension does this in real life, and the
 * promise is the general one.
 */
suite('the shell the environment gets first', () => {
  const NAME = 'gripterm-m225';

  test('M2.25: the launch line comes after what the environment types', async () => {
    const { gateway } = await api();
    const file = path.join(os.tmpdir(), 'gripterm-m225-order.txt');
    fs.rmSync(file, { force: true });

    const other = vscode.window.onDidOpenTerminal((terminal) => {
      if (terminal.name === NAME) {
        terminal.sendText(marker('other', file), true);
      }
    });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: NAME,
      cwd: os.tmpdir(),
      env: {},
      // `null` is the shell mode: the person's own shell, with the agent typed
      // into it. The process mode has no shell to share and no ordering to keep.
      shellPath: null,
      shellArgs: [],
    });

    try {
      handle.runLaunchCommand(marker('ours', file));

      assert.deepEqual(
        await linesOf(file, 2, 45000),
        ['other', 'ours'],
        'the launch line did not wait for the environment'
      );
    } finally {
      other.dispose();
      handle.dispose();
      fs.rmSync(file, { force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('M2.25: waits out an environment that waits for the shell as well', async () => {
    /*
     * The case the grace exists for, and the reason the wait is not simply a
     * delay counted from the terminal's creation.
     *
     * The stand-in above types at once, and a line typed into a shell that has
     * not come up yet is BUFFERED -- so whoever typed first still runs first,
     * and any wait at all would pass that test. This one types only after the
     * shell has announced itself, which is what a careful extension does: the
     * one that prompted this milestone waits six seconds before it even starts
     * listening. Against that, a wait that ends when the shell announces itself
     * is too early, and only the grace after the announcement holds the order.
     */
    const { gateway } = await api();
    const file = path.join(os.tmpdir(), 'gripterm-m225-late.txt');
    fs.rmSync(file, { force: true });
    const name = 'gripterm-m225-late';
    let typed = false;

    const other = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal.name !== name || typed) {
        return;
      }
      typed = true;
      // Comfortably inside the grace, and well after it in the mutant that has
      // none: 800 ms against a grace of 1500.
      setTimeout(() => {
        event.terminal.sendText(marker('other', file), true);
      }, 800);
    });

    const handle = await gateway.create({
      terminalId: { value: '550e8400-e29b-41d4-a716-4466554400a3' } as unknown as Spec['terminalId'],
      name,
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      handle.runLaunchCommand(marker('ours', file));

      assert.deepEqual(
        await linesOf(file, 2, 45000),
        ['other', 'ours'],
        'the launch line overtook an environment that was waiting for the shell'
      );
    } finally {
      other.dispose();
      handle.dispose();
      fs.rmSync(file, { force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('M2.25: types the launch line into a shell nobody else touches', async () => {
    // The other half of the promise, and the one that would be broken by a wait
    // with no end: a terminal where nothing else ever happens must still start
    // its agent.
    const { gateway } = await api();
    const file = path.join(os.tmpdir(), 'gripterm-m225-alone.txt');
    fs.rmSync(file, { force: true });

    const handle = await gateway.create({
      terminalId: { value: '550e8400-e29b-41d4-a716-4466554400a2' } as unknown as Spec['terminalId'],
      name: 'gripterm-m225-alone',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      handle.runLaunchCommand(marker('ours', file));

      assert.deepEqual(await linesOf(file, 1, 45000), ['ours'], 'the launch line was never typed');
    } finally {
      handle.dispose();
      fs.rmSync(file, { force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
