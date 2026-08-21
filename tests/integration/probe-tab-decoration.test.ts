import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * TEMPORARY INSTRUMENT for the customer's complaint 3, 2026-08-21: "Иконка
 * статуса не отображается в табе терминала, но отображается в treeview".
 *
 * The editor offers no way to change a terminal's icon after it is created, and
 * its name can only be changed while it is the active terminal. The one door
 * left is a file decoration -- a badge and a colour the workbench draws on a
 * tab -- and whether it reaches a TERMINAL tab is not documented anywhere. So:
 * register a provider that says yes to everything it is asked about, open a
 * terminal, and report which uris the workbench asked for.
 */

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const PROBE_ID = '550e8400-e29b-41d4-a716-4466553102dd';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function waitFor(what: string, ready: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function columnOf(label: string): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.label.includes(label))
  )?.viewColumn;
}

suite('PROBE: what the workbench asks a decoration provider about', () => {
  test('numbers several terminals', async () => {
    const { gateway } = await api();
    const asked: string[] = [];
    const provider = vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme.includes('terminal')) {
          asked.push(`${uri.toString()} <- ${vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)).join('/')}`);
          return { badge: 'GT', color: new vscode.ThemeColor('charts.red') };
        }
        return undefined;
      },
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const made: vscode.Disposable[] = [];
    try {
      for (const [index, name] of ['ours-one', 'ours-two'].entries()) {
        const handle = await gateway.create({
          terminalId: `550e8400-e29b-41d4-a716-44665510ee0${String(index)}` as unknown as Spec['terminalId'],
          name: `gripterm-probe-${name}`,
          cwd: os.tmpdir(),
          env: {},
          shellPath: null,
          shellArgs: [],
        });
        made.push(handle);
        await waitFor(`${name} to get a tab`, () => columnOf(`gripterm-probe-${name}`) !== undefined);
        handle.show(false);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        console.log(`[probe] after ${name}: ${JSON.stringify(asked)}`);

        // Somebody else's terminal, made through the same API, in the editor area.
        const foreign = vscode.window.createTerminal({
          name: `foreign-${name}`,
          location: vscode.TerminalLocation.Editor,
        });
        made.push(foreign);
        foreign.show(false);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        console.log(`[probe] after foreign-${name}: ${JSON.stringify(asked)}`);
      }
    } finally {
      provider.dispose();
      for (const one of made) {
        one.dispose();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('opens a terminal and reports the uris', async () => {
    const { gateway } = await api();
    const asked: string[] = [];
    const provider = vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        asked.push(uri.toString());
        return uri.scheme.includes('terminal')
          ? { badge: 'GT', tooltip: 'the probe was here', color: new vscode.ThemeColor('charts.red') }
          : undefined;
      },
    });

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const handle = await gateway.create({
      terminalId: PROBE_ID as unknown as Spec['terminalId'],
      name: 'gripterm-probe-badge',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-probe-badge') !== undefined);
      handle.show(false);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const terminals = asked.filter((uri) => uri.includes('terminal'));
      console.log(`[probe] uris asked about : ${String(asked.length)}`);
      console.log(`[probe] with 'terminal'  : ${JSON.stringify(terminals)}`);
      console.log(`[probe] a sample         : ${JSON.stringify(asked.slice(0, 12))}`);

      // And what the tab itself is made of, since the API may name the uri there.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input: unknown = tab.input;
          console.log(
            `[probe] tab "${tab.label}" input=${typeof input === 'object' && input !== null ? input.constructor.name : String(input)}`
          );
        }
      }
    } finally {
      provider.dispose();
      handle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
