import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WRITE_DEBOUNCE_MS,
  HumanMetadata,
  LaunchRecipe,
  ObservedState,
  SessionId,
  TerminalEntry,
  TerminalId,
  ownerRefFor,
  terminalTargetOf,
  type OwnerIdentity,
  type PersistedTerminalState,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';
import type {
  TerminalTreeDataProvider,
  TerminalTreeNode,
} from '../../packages/extension/src/ui/terminal-tree';

const ROW_TERMINAL = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const ROW_SESSION = '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A record in exactly the state the notification is about: a restore that
 * failed. Owned by THIS window, because a foreign row is not one this window
 * may act on -- and the button is about acting on it.
 */
function failedRestore(identity: OwnerIdentity): TerminalEntry {
  return rowInState(identity, 'resume_failed');
}

/** The same record in whatever state the test is about. */
function rowInState(identity: OwnerIdentity, state: PersistedTerminalState): TerminalEntry {
  const now = new Date();
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(ROW_TERMINAL),
    sessionId: SessionId.fromString(ROW_SESSION),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: 'a record this suite made',
      task: null,
      notes: [],
      tags: [],
      color: null,
    }),
    launch: LaunchRecipe.create({
      cwd: process.cwd(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    }),
    observed: ObservedState.create({
      state,
      lastEventAt: now,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt: now,
  });
}

/**
 * What the workbench would call this node -- asked of the provider, which is who
 * the workbench asks.
 *
 * Reading the node's own fields is what this file may NOT do: the host loads the
 * bundle and this file is compiled beside it, so the classes here are not the
 * classes there, and a value imported out of the extension does not even load
 * (its `@gripterm/core` is a name only the bundler resolves). The tree item's id
 * crosses both boundaries because it is a string.
 */
function named(tree: TerminalTreeDataProvider, node: TerminalTreeNode): string {
  return String(tree.getTreeItem(node).id);
}

/**
 * Whatever the row left in the store on its way through.
 *
 * Registering a record makes this window a writer of it, so the base gets a
 * directory and the removal turns that into a trash entry. Both are this
 * suite's own and both go; the wait is the write debounce, so that a write
 * still in flight is not cleaned up before it lands.
 */
async function cleanUp(storageDir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_WRITE_DEBOUNCE_MS * 2));
  await rm(join(storageDir, 'terminals', ROW_TERMINAL), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, ROW_TERMINAL), { recursive: true, force: true });
    // Registering a record makes the base change, and a base that changed puts
    // the sweep out of turn (M2.12) -- which can leave an empty `owners/` behind
    // whichever test happened to provoke it. Whoever runs last tidies it.
    const inOwners = await readdir(join(trash, stamp, 'owners')).catch(() => ['keep']);
    if (inOwners.length === 0) {
      await rm(join(trash, stamp, 'owners'), { recursive: true, force: true });
    }
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

/**
 * What only a real editor can answer about the list: that the view is
 * CONTRIBUTED and registered with the workbench, not merely constructed.
 *
 * How a row looks -- icon, colour, description, `contextValue` -- is settled in
 * `tests/domain/terminal-presentation.test.ts` against the pure presenter,
 * where every state is covered. Repeating that here would test the same table
 * twice and the wiring not at all.
 */
suite('the terminals view', () => {
  test('is registered with the workbench, so the editor offers its focus command', async () => {
    // `<viewId>.focus` is contributed by the platform for every declared view.
    // Its absence is exactly the failure that a manifest typo produces, and the
    // one an in-process check of our own objects would miss.
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes('gripterm.terminals.focus'),
      'the terminals view is not registered with the workbench'
    );
  });

  test('can be revealed', async () => {
    await vscode.commands.executeCommand('gripterm.terminals.focus');
  });

  /*
   * The button on the `resume_failed` toast, end to end (M2.13).
   *
   * Only a real editor answers this one. `reveal` belongs to the platform and is
   * refused outright unless the data provider offers `getParent` -- a rule
   * nothing in the unit suite knows about, and one whose breach is quiet: the
   * command catches, the list still opens, and the row a person was sent to is
   * simply not selected.
   */
  test('selects the row a notification points at', async () => {
    const { registry, view, tree, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      await vscode.commands.executeCommand('gripterm.showRecord', ROW_TERMINAL);

      assert.deepEqual(
        view.selection.map((node) => named(tree, node)),
        [ROW_TERMINAL],
        'the record was not selected in the list'
      );
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });

  /*
   * The grouping, as the contributed view actually hands it back (M2.14).
   *
   * WHICH heading a record belongs under is decided in `groupTerminals` and
   * covered there against every spelling of a path. What only a host answers is
   * the shape of the tree it drew: that the root is headings and the rows are
   * beneath them. A provider that returned rows at the root would look right in
   * every unit test and wrong in the sidebar.
   */
  /*
   * The seventh thing the customer asked for, 2026-08-21: a click on the row
   * should open that terminal, rather than the small icon at the end of it
   * being the only way in.
   *
   * WHICH rows open is settled in `tests/domain/terminal-presentation.test.ts`
   * against the pure presenter. What only a host answers is that the tree item
   * the workbench receives carries the command at all -- a `command` set on the
   * wrong object, or an argument the resolver cannot read, looks right in every
   * unit test and does nothing in the sidebar.
   */
  test('carries the command that opens a live terminal, and carries none on a row that is over', async () => {
    const { registry, tree, identity, readiness } = await api();

    for (const [state, expected] of [
      ['working', 'gripterm.focusTerminal'],
      ['resume_failed', undefined],
    ] as const) {
      const entry = rowInState(identity, state);
      registry.register(entry);
      try {
        const row = tree
          .getChildren()
          .flatMap((heading) => tree.getChildren(heading))
          .find((node) => named(tree, node) === ROW_TERMINAL);
        assert.ok(row, `the ${state} row is not in the list at all`);

        const item = tree.getTreeItem(row);

        assert.equal(
          item.command?.command,
          expected,
          `a ${state} row offered ${String(item.command?.command)} on a click`
        );
        if (expected !== undefined) {
          // The id and not the entry: a string is what crosses the bundle
          // boundary, and what `terminalTargetOf` reads on the other side.
          const carried = item.command?.arguments;
          assert.deepEqual(carried, [ROW_TERMINAL], 'the click names no terminal');
          assert.equal(
            terminalTargetOf(carried[0]).kind,
            'terminal',
            'the argument of the click is not one the command can read'
          );
        }
      } finally {
        registry.forget(entry.terminalId);
        await cleanUp(readiness.storageDir);
      }
    }
  });

  test('draws headings at the root and the rows underneath them', async () => {
    const { registry, tree, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      const roots = tree.getChildren();

      assert.ok(roots.length > 0, 'the list has no headings at all');
      assert.deepEqual(
        [...new Set(roots.map((node) => named(tree, node).split(':')[0]))],
        ['project'],
        'a terminal is drawn at the root of the list rather than under a project'
      );
      const holding = roots.filter((root) =>
        tree.getChildren(root).some((child) => named(tree, child) === ROW_TERMINAL)
      );
      assert.equal(holding.length, 1, 'the record is not under exactly one heading');
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });

  /*
   * The boundary this suite runs across, discovered by a run (M2.21).
   *
   * The host loads the BUNDLE, and this file is compiled separately: there are
   * two copies of every class in `@gripterm/core` in the same process, and a
   * record built here is not an `instanceof` anything the bundle holds. The
   * suite drives the extension with records of its own all the same -- that is
   * how it puts a row on the screen at all -- so the list may not tell a heading
   * from a row by asking which class the node is. It asks what the node HAS,
   * which crosses the boundary.
   *
   * The cost of getting this wrong is not a wrong row: `getTreeItem` took the
   * heading branch, read `group.key` off a record, and threw inside the
   * platform's own draw.
   */
  test('draws a registered record as its own row', async () => {
    const { registry, tree, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      assert.equal(
        tree.getTreeItem(entry).id,
        ROW_TERMINAL,
        'the list does not draw a record as its own row'
      );
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });

  /*
   * The other half of M2.21: what a row command does when it cannot read what it
   * was handed.
   *
   * `packages/extension` is outside the coverage thresholds (§3.5), and this is
   * the branch nothing else reaches. It must say so and stop. What it must NOT
   * do is what it used to: fall through to the picker, which offers OTHER
   * terminals with the first one selected -- one Enter from another record in
   * the trash.
   *
   * The observable is the promise. A picker waits for a person, so a command
   * that opened one never finishes; the record registered above is what makes
   * sure there is something for a picker to offer, or the wrong build would
   * finish quickly too, having found nothing.
   */
  test('a row command handed something it cannot read does not ask which terminal', async () => {
    const { registry, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      const done = Promise.resolve(
        vscode.commands.executeCommand('gripterm.deleteTerminal', { not: 'a terminal' })
      ).then(() => 'finished');
      const waited = new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('still asking which terminal');
        }, 5000);
      });

      const outcome = await Promise.race([done, waited]);
      // Whatever it opened is not left open for the next test.
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

      assert.equal(outcome, 'finished', 'the command asked which terminal instead of saying so');
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });

  /*
   * The defect the owner found, and the reason it needs a host (M2.21).
   *
   * A row's menu hands the command the ELEMENT this provider returned, and every
   * one of those commands asks `terminalTargetOf` what it was given. From M2.14
   * that element was a wrapper around the entry -- correct TypeScript, correct
   * `TreeDataProvider`, and correct in any unit test that built a tree by hand --
   * and nothing recognised it. So every menu entry on every row fell through to
   * the picker: `Delete Record` on a row answered "the record of WHICH
   * terminal?", offering other terminals with the first one selected. Nothing
   * threw, nothing was logged, and only a person clicking a row could see it.
   *
   * This asserts the join the wrapper broke, over the tree the workbench is
   * actually drawing from: a row of the list resolves to the terminal it draws.
   */
  test('hands back rows the row menus can act on', async () => {
    const { registry, tree, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      // Every row is put through the resolver the commands use, and nothing
      // else touches the nodes: a test that first found the row by reading its
      // fields would be testing the shape it expected rather than the one the
      // commands can read.
      const rows = tree.getChildren().flatMap((heading) => tree.getChildren(heading));
      const answers = rows
        .map((row) => terminalTargetOf(row))
        .map((one) => (one.kind === 'terminal' ? one.terminalId.value : one.kind));

      assert.ok(
        answers.includes(ROW_TERMINAL),
        'a row of the list does not resolve to the terminal it draws, so its menu asks ' +
          `which terminal; the rows answered ${JSON.stringify(answers)}`
      );
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });
});
