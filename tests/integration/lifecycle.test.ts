import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONTEXT_LIVE, CONTEXT_OVER, LaunchRecipe } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

type LaunchRequest = Parameters<GriptermApi['lifecycle']['launch']>[0];

interface MenuItem {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function menuItems(): readonly MenuItem[] {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension);
  const manifest = extension.packageJSON as {
    contributes: { menus: Record<string, MenuItem[]> };
  };
  return manifest.contributes.menus['view/item/context'] ?? [];
}

function request(): LaunchRequest {
  return {
    displayName: 'gripterm-pending',
    recipe: LaunchRecipe.create({
      cwd: os.tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    }),
  };
}

suite('the lifecycle commands', () => {
  test('are registered, so the manifest is not promising buttons that do nothing', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('gripterm.newTerminal'), 'newTerminal is not registered');
    assert.ok(commands.includes('gripterm.closeTerminal'), 'closeTerminal is not registered');
  });

  test('key their row menus on the context values the presenter actually produces', async () => {
    // A `when` clause naming a `viewItem` the presenter never sets is a menu
    // entry that simply never appears -- silent everywhere else, because nothing
    // fails and nothing is logged. This is the only place the two spellings meet.
    await api();
    const items = menuItems();
    assert.ok(items.length > 0, 'the view contributes no row menu at all');

    const named = items.map((item) => /viewItem == ([\w.]+)/u.exec(item.when)?.[1]);
    assert.ok(
      named.every((value) => value !== undefined),
      'a row menu is shown for every row, whatever its state'
    );
    assert.deepEqual([...new Set(named)].sort(), [CONTEXT_LIVE, CONTEXT_OVER].sort());
  });

  test('do nothing dramatic when there is no terminal to close', async () => {
    // The palette path with an empty list. It says so and returns; a command
    // that waited on the notification it just raised would never return at all.
    await api();

    await vscode.commands.executeCommand('gripterm.closeTerminal');
  });
});

suite('starting a terminal', () => {
  /**
   * **This test goes red in M1.14, and that is its job.**
   *
   * `PendingAgentCommandFactory` is a refusal standing in for the launch
   * pipeline -- finding `claude`, the hook server's address, the per-terminal
   * `settings.json`. Composing the real one turns both assertions below false at
   * once, which is how the placeholder gets removed rather than discovered.
   */
  test('refuses until the launch pipeline is composed (M1.14)', async () => {
    const { lifecycle, registry } = await api();
    const held = registry.list().length;

    await assert.rejects(lifecycle.launch(request()), /M1\.14/u);

    // And no record is left behind. A launch that never produced a terminal must
    // not leave a row stuck in `launching` for the life of the window.
    assert.equal(registry.list().length, held);
  });
});
