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
      state: 'resume_failed',
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
    const { registry, view, identity, readiness } = await api();
    const entry = failedRestore(identity);
    registry.register(entry);

    try {
      await vscode.commands.executeCommand('gripterm.showRecord', ROW_TERMINAL);

      assert.deepEqual(
        view.selection.map((row) => row.terminalId.value),
        [ROW_TERMINAL],
        'the record was not selected in the list'
      );
    } finally {
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });
});
