import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

/** The gateway keys on `.value` alone; the brand exists to stop this happening anywhere but a test. */
const TERMINAL_ID = { value: '550e8400-e29b-41d4-a716-446655440000' } as unknown as Spec['terminalId'];

/** The shape `vscode.getEditorLayout` answers with. Read here, never written here. */
interface LayoutNode {
  readonly size?: number;
  readonly groups?: readonly LayoutNode[];
}

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

/** The column of the group holding a tab with that label, or `undefined`. */
function columnOf(label: string): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.label.includes(label))
  )?.viewColumn;
}

function groupAt(column: vscode.ViewColumn): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all.find((group) => group.viewColumn === column);
}

/**
 * How much of its parent the group at `index` takes, walking the editor's own
 * answer. Deliberately NOT `withGroupShare` read backwards: a test that checks
 * an implementation with the same implementation checks nothing.
 */
function shareOf(layout: { readonly groups: readonly LayoutNode[] }, index: number): number | null {
  let seen = 0;
  const walk = (siblings: readonly LayoutNode[]): number | null => {
    for (const node of siblings) {
      if (node.groups === undefined) {
        if (seen === index) {
          const total = siblings.reduce((sum, one) => sum + (one.size ?? 0), 0);
          return total === 0 ? null : (node.size ?? 0) / total;
        }
        seen += 1;
      } else {
        const found = walk(node.groups);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  return walk(layout.groups);
}

async function layoutNow(): Promise<{ readonly groups: readonly LayoutNode[] }> {
  return await vscode.commands.executeCommand<{ readonly groups: readonly LayoutNode[] }>(
    'vscode.getEditorLayout'
  );
}

/**
 * M2.24. The owner asked for the agents to open "in a separate panel of their
 * own, at the bottom, the way ordinary terminals do". An extension cannot have
 * a panel -- `TerminalLocation` offers the editor's one panel and the editor
 * area, and nothing else -- so what is built instead is a GROUP of the editor
 * area, below the editors and locked, which is the same picture made of the
 * parts the platform hands out.
 *
 * Everything asserted here was measured first, in this host, on 2026-08-13:
 * `newGroupBelow` nests under the active column rather than restacking the
 * window; a locked group turns away an editor opened with no target and still
 * takes ours when we name its column; and the group goes on its own when its
 * last terminal does.
 */
suite('the strip of our own', () => {
  test('M2.24: keeps a group below the editors that holds our terminals and nothing else', async () => {
    const { gateway, readiness } = await api();
    assert.equal(readiness.location, 'group', 'this build no longer opens terminals in a strip of their own');

    /*
     * The editor locks a group holding a terminal editor BY ITSELF: measured
     * 2026-08-13, `workbench.editor.autoLockGroups` has `terminalEditor: true`
     * in its default, and a document opened with the strip focused landed among
     * the editors with nothing of ours locking anything.
     *
     * So it is turned off here, and that is the point of the test rather than
     * setup for it. With it on, the assertion about the lock passes on a build
     * that locks nothing -- the mutation bench proved exactly that -- and the
     * promise "ours and nothing else" would rest on a setting the person is
     * free to turn off. Turned off, what holds the strip is our own lock.
     */
    const settings = vscode.workspace.getConfiguration('workbench.editor');
    const autoLock = settings.inspect<Record<string, boolean>>('autoLockGroups');
    await settings.update(
      'autoLockGroups',
      { ...autoLock?.defaultValue, ...autoLock?.globalValue, terminalEditor: false },
      vscode.ConfigurationTarget.Global
    );

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({
      content: 'a file the person is working on',
      language: 'plaintext',
    });
    const editors = (await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One }))
      .viewColumn;

    const one = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-one',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      await waitFor('the first terminal to get a tab', () => columnOf('gripterm-m224-one') !== undefined);
      const strip = columnOf('gripterm-m224-one');
      assert.ok(strip !== undefined);
      assert.notEqual(strip, editors, 'our terminal opened among the editors');

      // A strip is a strip because of what is NOT in it.
      const held = groupAt(strip);
      assert.ok(held);
      assert.ok(
        held.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal),
        'something that is not a terminal is in our group'
      );

      // About a third of what it shares its space with. Not exact: the editor
      // answers in pixels and rounds, and a person is free to drag it.
      const share = shareOf(await layoutNow(), strip - 1);
      assert.ok(share !== null, 'the editor reports no size for our group');
      assert.ok(share > 0.28 && share < 0.4, `our group takes ${String(share)} of its parent`);

      /*
       * The lock, established the only way it can be: by what the editor does.
       * There is no API that reports a group as locked.
       *
       * The strip has to be the ACTIVE group first, and that is the whole
       * assertion rather than a detail of it. Without this the document lands
       * among the editors because that is where the focus was -- which is what
       * happens with no lock at all, so the test would pass on a build that had
       * dropped it. The mutation bench found exactly that on 2026-08-13.
       */
      one.show(false);
      await waitFor(
        'the strip to become the active group',
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === strip
      );
      const second = await vscode.workspace.openTextDocument({
        content: 'another file, opened with no target at all',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(second)).viewColumn;
      assert.notEqual(landed, strip, 'a file opened into our group, so the lock is not holding');

      // The second terminal joins the first. A strip per terminal would be the
      // same defect wearing the opposite face.
      const two = await gateway.create({
        terminalId: { value: '550e8400-e29b-41d4-a716-446655440001' } as unknown as Spec['terminalId'],
        name: 'gripterm-m224-two',
        cwd: os.tmpdir(),
        env: {},
        shellPath: null,
        shellArgs: [],
      });
      try {
        await waitFor('the second terminal to get a tab', () => columnOf('gripterm-m224-two') !== undefined);
        /*
         * Both in ONE group, asked as "the same group as the first" and not as
         * "the column the first one had". The editor renumbers its columns
         * whenever a group is added before them, so a build that opened a
         * second strip could still answer the remembered number -- which is how
         * this assertion first passed on a build that did open one.
         */
        assert.equal(
          columnOf('gripterm-m224-two'),
          columnOf('gripterm-m224-one'),
          'our two terminals are in different groups'
        );
        assert.equal(
          vscode.window.tabGroups.all.length,
          2,
          'there is more than one group beside the editors'
        );
      } finally {
        two.dispose();
      }
    } finally {
      one.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await settings.update(
        'autoLockGroups',
        autoLock?.globalValue,
        vscode.ConfigurationTarget.Global
      );
    }
  });

  test('M2.24: lets the strip go when its last terminal goes', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({ content: 'kept open', language: 'plaintext' });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-last',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-last') !== undefined);
    assert.equal(vscode.window.tabGroups.all.length, 2, 'the strip did not appear beside the editors');

    handle.dispose();

    // The editor closes a group that has nothing left in it, which is what makes
    // "opened at the first terminal" the whole of the rule -- there is no
    // second rule that has to remember to take it away.
    await waitFor(
      'the strip to go with the terminal',
      () => vscode.window.tabGroups.all.length === 1,
      10000
    );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
