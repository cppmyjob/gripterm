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
  type OwnerIdentity,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';
import type {
  TerminalTreeDataProvider,
  TerminalTreeNode,
} from '../../packages/extension/src/ui/terminal-tree';

/**
 * A row of the list dragged with the platform's own drag and drop.
 *
 * **What the owner reported on 2026-08-21**, having checked the panel's tabs by
 * hand: "не реализован drag and drop в tree view где список всех терминалов".
 * One arrangement for the strip and the list both was their decision the same
 * day, so a list that cannot be arranged is half of it.
 *
 * **Why this is a live test.** Which record moves and which drop is refused is
 * settled in `tests/domain/tree-drop.test.ts` against the pure rule. What no
 * unit test can reach is the SEAM: the platform hands a controller its nodes
 * and a `DataTransfer`, and everything about that -- whether the mime type
 * matches, whether the node that comes back is the one that went in, whether an
 * amended record redraws the list -- is the editor's, not ours. This suite
 * calls the controller the way the workbench does.
 */

const FIRST_ROW = '7a1b2c3d-4e5f-4061-8273-8495a6b7c8d1';
const SECOND_ROW = '7a1b2c3d-4e5f-4061-8273-8495a6b7c8d2';
const FIRST_SESSION = '7a1b2c3d-4e5f-4061-8273-8495a6b7c8e1';
const SECOND_SESSION = '7a1b2c3d-4e5f-4061-8273-8495a6b7c8e2';

const MINUTE_MS = 60_000;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** A record of this window, made at a named moment: the moment is the order. */
function rowFor(
  identity: OwnerIdentity,
  terminalId: string,
  sessionId: string,
  name: string,
  createdAt: Date
): TerminalEntry {
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(terminalId),
    sessionId: SessionId.fromString(sessionId),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: name,
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
      state: 'idle',
      lastEventAt: createdAt,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt,
  });
}

/**
 * What the workbench would call this node.
 *
 * Asked of the provider rather than read off the node, and that is the rule of
 * this whole directory: the host runs the BUNDLE while this file is compiled
 * beside it, so the classes here are not the classes there. The tree item id is
 * a string, and a string crosses.
 */
function named(tree: TerminalTreeDataProvider, node: TerminalTreeNode): string {
  return String(tree.getTreeItem(node).id);
}

/** Every row of the list, under every heading. */
function rows(tree: TerminalTreeDataProvider): readonly TerminalTreeNode[] {
  return tree.getChildren().flatMap((heading) => tree.getChildren(heading));
}

/**
 * This suite's two rows, in the order the LIST has them.
 *
 * Filtered rather than counted: every suite of the gate runs in one window and
 * leaves records behind it, so a test that expected a list of exactly two would
 * pass alone and fail in the run that matters.
 */
function drawn(tree: TerminalTreeDataProvider): readonly string[] {
  return rows(tree)
    .map((node) => named(tree, node))
    .filter((id) => id === FIRST_ROW || id === SECOND_ROW);
}

/** The heading a row of this suite is under. */
function headingOf(tree: TerminalTreeDataProvider, terminalId: string): TerminalTreeNode {
  const heading = tree
    .getChildren()
    .find((one) => tree.getChildren(one).some((child) => named(tree, child) === terminalId));
  assert.ok(heading, 'the row is under no heading at all');
  return heading;
}

function rowNode(tree: TerminalTreeDataProvider, terminalId: string): TerminalTreeNode {
  const node = rows(tree).find((child) => named(tree, child) === terminalId);
  assert.ok(node, `the list has no row for ${terminalId}`);
  return node;
}

/**
 * A drag, made the way the workbench makes one: the controller fills a
 * transfer, and the same transfer is handed back at the drop.
 */
function drag(
  tree: TerminalTreeDataProvider,
  moved: TerminalTreeNode,
  onto: TerminalTreeNode
): void {
  const transfer = new vscode.DataTransfer();
  // No cancellation token: the workbench passes one and the controller takes
  // no argument for it, because there is nothing here to cancel -- the whole
  // drop is one synchronous write into the registry.
  tree.handleDrag([moved], transfer);
  tree.handleDrop(onto, transfer);
}

/** Everything these two records left in the person's store. */
async function cleanUp(storageDir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_WRITE_DEBOUNCE_MS * 2));
  for (const terminalId of [FIRST_ROW, SECOND_ROW]) {
    await rm(join(storageDir, 'terminals', terminalId), { recursive: true, force: true });
  }
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    for (const terminalId of [FIRST_ROW, SECOND_ROW]) {
      await rm(join(trash, stamp, terminalId), { recursive: true, force: true });
    }
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

suite('a row of the list, dragged', () => {
  suiteSetup(async () => {
    const { registry, identity } = await api();
    const madeAt = Date.now() - 2 * MINUTE_MS;
    registry.register(
      rowFor(identity, FIRST_ROW, FIRST_SESSION, 'gripterm-row-one', new Date(madeAt))
    );
    registry.register(
      rowFor(identity, SECOND_ROW, SECOND_SESSION, 'gripterm-row-two', new Date(madeAt + MINUTE_MS))
    );
  });

  suiteTeardown(async () => {
    const { registry, readiness } = await api();
    for (const terminalId of [FIRST_ROW, SECOND_ROW]) {
      registry.forget(TerminalId.fromString(terminalId));
    }
    await cleanUp(readiness.storageDir);
  });

  test('stands the rows in the order they were made until somebody says otherwise', async () => {
    const { tree } = await api();

    assert.deepEqual([...drawn(tree)], [FIRST_ROW, SECOND_ROW]);
  });

  test('moves the row a person drops on another, and writes it into the record', async () => {
    const { tree, registry } = await api();

    drag(tree, rowNode(tree, SECOND_ROW), rowNode(tree, FIRST_ROW));

    assert.deepEqual([...drawn(tree)], [SECOND_ROW, FIRST_ROW], 'the list did not follow the hand');
    const moved = registry.get(TerminalId.fromString(SECOND_ROW));
    const other = registry.get(TerminalId.fromString(FIRST_ROW));
    assert.ok(moved, 'the record of the dragged row is gone');
    assert.ok(other, 'the record of the other row is gone');
    assert.notEqual(moved.order, null, 'the row moved and nothing was written down');
    assert.ok(
      moved.placement < other.placement,
      `the record still says the dragged row is behind: ${String(moved.placement)} vs ${String(other.placement)}`
    );
  });

  test('takes a row dropped on its own heading to the top', async () => {
    const { tree } = await api();

    drag(tree, rowNode(tree, FIRST_ROW), headingOf(tree, FIRST_ROW));

    assert.deepEqual([...drawn(tree)], [FIRST_ROW, SECOND_ROW], 'the row did not go to the top');
  });

  test('leaves the list alone when the drop carried nothing', async () => {
    const { tree } = await api();
    const before = [...drawn(tree)];

    // An empty transfer is what arrives from any other view in the workbench,
    // and answering it with a move would be moving a row nobody dragged.
    tree.handleDrop(rowNode(tree, SECOND_ROW), new vscode.DataTransfer());

    assert.deepEqual([...drawn(tree)], before);
  });
});
