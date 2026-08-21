import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

/**
 * The green button on a terminal nothing was ever said in.
 *
 * **What the customer reported on 2026-08-21:** "Если открыть новый терминал и
 * туда ничего не вводить и закрыть терминал принудительно, то это окно нельзя
 * восстановить через зелёную кнопку в treeview."
 *
 * They are right, and the answer had already been decided -- for the other
 * door. The owner ruled the same day that a record nothing was said in comes
 * back with a NEW conversation, because `--resume` on a conversation with no
 * transcript is measured to fail; `planRestore` has answered that way since,
 * and the button had not followed. So the same record came back by itself at
 * the next start of the window and refused to come back when asked for.
 *
 * **Why this is a live test.** WHICH answer the rule gives is settled in
 * `tests/domain/restore-planner.test.ts` against `resumeIntent`, over every
 * refusal there is. What no unit test can reach is the seam: a command
 * registered with the workbench, a record this window really holds, the real
 * `claude agents --json` and the real transcripts of this machine standing
 * behind the decision, and a terminal that really opens. This suite presses the
 * button.
 *
 * **Nothing of the person's is touched.** The record is made by this test,
 * owned by this window, points at a conversation that does not exist and runs
 * in the temporary directory. Its terminal is closed and its files removed in a
 * `finally`, whatever happens.
 */

const NEVER_SPOKEN = '3f1e2d4c-5b6a-4978-8c9d-0e1f2a3b4c5d';
/** A conversation nobody ever said anything in: no transcript names it. */
const ABSENT_SESSION = '4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f';

/**
 * Long before this machine last booted, which is how the record says its
 * process is not running.
 *
 * The rule that reads it (`mayBeRunning`) treats a record with no pid as
 * possibly alive -- the honest reading when there is no evidence -- and only an
 * event older than the boot settles it. A date in the past is that evidence,
 * and it is the one this test needs: without it the button would refuse with
 * `session-running` and the suite would be measuring the wrong refusal.
 */
const BEFORE_THIS_BOOT = new Date('2020-01-01T00:00:00.000Z');

const SETTLES_WITHIN_MS = 30_000;
const POLL_MS = 100;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A terminal that was opened, never typed in, and is over.
 *
 * No `closedAt`: the person did not close it through Gripterm, its terminal
 * simply went. That is the customer's case exactly, and it is also what keeps
 * this test runnable -- a record with `closedAt` set puts a modal in front of
 * the resume, and no suite can answer a modal.
 */
function neverSpokenIn(identity: OwnerIdentity): TerminalEntry {
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(NEVER_SPOKEN),
    sessionId: SessionId.fromString(ABSENT_SESSION),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: 'a terminal nothing was said in',
      task: 'the task that must survive the way back',
      notes: [],
      tags: [],
      color: null,
    }),
    launch: LaunchRecipe.create({
      cwd: tmpdir(),
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
      state: 'ended',
      lastEventAt: BEFORE_THIS_BOOT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt: BEFORE_THIS_BOOT,
  });
}

async function until(what: string, ready: () => boolean, ms = SETTLES_WITHIN_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`waited ${String(ms)} ms for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Whatever this suite left in the store, and nothing else. */
async function cleanUp(storageDir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_WRITE_DEBOUNCE_MS * 2));
  await rm(join(storageDir, 'terminals', NEVER_SPOKEN), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, NEVER_SPOKEN), { recursive: true, force: true });
  }
}

suite('the green button on a conversation that was never spoken in', () => {
  test('brings the record back with a new conversation, keeping its name and task', async () => {
    const { registry, gateway, identity, readiness } = await api();
    const entry = neverSpokenIn(identity);
    registry.register(entry);

    try {
      await vscode.commands.executeCommand('gripterm.resumeTerminal', NEVER_SPOKEN);

      await until(
        'the record to come back holding a conversation of its own',
        () => registry.get(entry.terminalId)?.sessionId.value !== ABSENT_SESSION
      );
      const back = registry.get(entry.terminalId);
      assert.ok(back, 'the record went away instead of coming back');

      // The conversation is new; the record is the same one, with everything a
      // person put on it. That is the whole of the owner's rule.
      assert.notEqual(back.sessionId.value, ABSENT_SESSION, 'the record kept a conversation that does not exist');
      assert.deepEqual(
        back.sessionIdHistory.map((past) => past.value),
        [ABSENT_SESSION],
        'the conversation that pointed at nothing was not kept in the history'
      );
      assert.equal(back.metadata.displayName, 'a terminal nothing was said in');
      assert.equal(back.metadata.task, 'the task that must survive the way back');
      assert.equal(back.closedAt, null, 'the record came back still closed');

      // And a terminal really opened for it, in this window.
      await until(
        'the terminal to be one this window holds',
        () => gateway.handleFor(entry.terminalId) !== undefined
      );
    } finally {
      gateway.handleFor(entry.terminalId)?.dispose();
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });
});
