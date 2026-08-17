import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The restore, in the one place it can be watched: a real editor, a real
 * terminal, and a real `claude --resume`.
 *
 * Nothing of the person's is touched. The record below is written by this test,
 * owned by a window that never existed, and points at a conversation id that has
 * no transcript -- so the CLI refuses it and starts nothing. It is removed again
 * in a `finally`, whatever happens.

 * This is also where A26 was measured, by the assertion below failing: the
 * refusal does NOT end the process when `claude` is the terminal's own process.
 *
 * The suite deliberately does NOT let activation restore anything. In a test
 * host that would adopt this machine's records and start `claude --resume` on
 * the person's own conversations as a side effect of running tests, so the
 * extension refuses it and this drives the orchestrator itself.
 */

const RESTORED_TERMINAL = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
/** A conversation that does not exist. Piped, `--resume` on it exits 1; in a terminal, see A26. */
const ABSENT_SESSION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const DEAD_WINDOW = 'integration-window-that-closed';

const SETTLES_WITHIN_MS = 30_000;
const POLL_MS = 100;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A record as a window that has since closed would have left it.
 *
 * Written as JSON rather than through our own encoder, for the reason
 * `shared-base.test.ts` gives: this is the contract as it exists on disk, and a
 * test that produced it with the encoder could not tell the two apart.
 *
 * `permissionMode` and every other flag are null on purpose. The command must
 * come out as `--resume <id> --settings <path>` and nothing else, so that the
 * only thing that can fail is the resume itself.
 */
function recordJson(now: number): string {
  return JSON.stringify({
    terminalId: RESTORED_TERMINAL,
    sessionId: ABSENT_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: DEAD_WINDOW,
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: {
      displayName: 'a conversation that is not there',
      task: null,
      notes: [],
      tags: [],
      color: null,
    },
    launch: {
      cwd: tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    createdAt: now,
    closedAt: null,
    revision: 3,
  });
}

function observedJson(now: number): string {
  return JSON.stringify({
    // Mid-turn, as a record left by a window that died would be. The restore has
    // to stamp `launching` over this, or the exit below reads as an ordinary end.
    state: 'working',
    lastEventAt: now,
    currentTool: 'Bash',
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

/**
 * The record is found by the STRING of its id rather than by building one.
 *
 * `TerminalId` is nominal, and this suite meets the extension through its
 * published types while the classes live in `packages/core/src` -- two
 * declarations of the same private field, which the compiler is right to refuse.
 * The id is a string on the wire anyway.
 */
async function stateWithin(gripterm: GriptermApi, wanted: string): Promise<string> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  let seen = 'nothing at all';
  while (Date.now() < deadline) {
    seen = gripterm.registry
      .list()
      .find((one) => one.terminalId.value === RESTORED_TERMINAL)?.observed.state ?? 'nothing at all';
    if (seen === wanted) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return seen;
}

/** Waits until this window no longer holds the terminal it was told to close. */
async function gone(gripterm: GriptermApi): Promise<void> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  while (Date.now() < deadline) {
    if (!gripterm.gateway.listKnown().some((one) => one.terminalId.value === RESTORED_TERMINAL)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('the terminal was still held after it was closed');
}

/** Everything this test put in the person's store, including what deletion left behind. */
async function cleanUp(storageDir: string): Promise<void> {
  await rm(join(storageDir, 'terminals', RESTORED_TERMINAL), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, RESTORED_TERMINAL), { recursive: true, force: true });
    // The stamp directory goes too when this test's record was all it held.
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

suite('bringing conversations back', () => {
  test('activation restores nothing in a test host, and says why', async () => {
    // The guard is the whole reason this suite may run on a machine that has
    // real records in `~/.gripterm`.
    const { readiness } = await api();

    // `assert.equal` narrows the union, which is why the reason can be read
    // straight off it on the next line.
    assert.equal(readiness.restore.kind, 'skipped');
    assert.match(readiness.restore.reason, /test host/u);
  });

  test('a record left by a window that is gone is adopted, started, and settled by the exit', async () => {
    const gripterm = await api();
    const { repository, restore, readiness } = gripterm;
    assert.ok(repository, 'this window is not reading the shared store');
    assert.ok(restore, 'no orchestrator was composed');

    const directory = join(readiness.storageDir, 'terminals', RESTORED_TERMINAL);
    try {
      await mkdir(directory, { recursive: true });
      const now = Date.now();
      await writeFile(join(directory, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(join(directory, 'record.json'), recordJson(now), 'utf8');

      const entry = (await repository.readAll()).find(
        (one) => one.terminalId.value === RESTORED_TERMINAL
      );
      assert.ok(entry, 'the record this test wrote is not readable');
      assert.equal(entry.revision, 3);

      const report = await restore.run({
        steps: [{ entry, expectedRevision: entry.revision, force: false }],
        skipped: [],
      });

      assert.equal(report.started, 1, JSON.stringify(report.attempts));
      // Adopted: the record now belongs to this window, which is what lets it
      // be written at all (§4.8).
      assert.equal(gripterm.registry.knows(entry.terminalId), true);
      assert.equal(
        gripterm.registry.get(entry.terminalId)?.owner.ownerId.value,
        gripterm.identity.ownerId.value
      );

      /*
       * **A26 IS REOPENED, and this test is the place it was found** (2026-08-17,
       * during M3.5). It used to assert `degraded`, on a measurement that no
       * longer holds: `claude --resume <a conversation that is not there>` was
       * observed in M2.11 to print its refusal and STAY under a pty, so the end of
       * a failed resume was the twenty-second wait rather than an exit.
       *
       * Re-measured today, three ways, because this test failing is not by itself
       * evidence of anything: under our own pty the CLI prints `No conversation
       * found with session ID: <id>` and EXITS WITH 1 after some 3.4 s (A44); the
       * editor reports that exit as `{code: 1, reason: 'user'}`, which is A29's
       * own row and needs nothing new; and the run above was proved not to be
       * this step's doing by stashing every change of M3.5 and watching a clean
       * tree fail identically.
       *
       * **Why the record says `ended` and not `resume_failed`, which is the part
       * worth reading.** Measured by instrumenting the lifecycle in that same
       * run: a `SessionEnd` hook arrives BEFORE the editor reports the close, so
       * by the time `deathEvent` asks, the record is already at a witnessed end
       * and the exit code that would have made it `resume_failed` is never read.
       *
       * **What that costs, stated rather than left green:** `resume_failed` is
       * the state M2.13 turns into an offer to start the conversation over, and
       * this path no longer reaches it. The row says the terminal ended -- true,
       * and not the whole truth. It is A45 in the register, unfixed on purpose:
       * the fix is a decision about which piece of first-hand evidence outranks
       * which, and that belongs to a step of its own rather than to the one that
       * happened to find it.
       */
      assert.equal(await stateWithin(gripterm, 'ended'), 'ended');

      // And the pane STAYS, which did not change with the CLI: the editor keeps
      // a terminal whose process has exited, wearing the exit code, so the
      // person can read the CLI's own refusal in the place it was printed. It is
      // also why the close event this record's state could have been read from
      // does not arrive until somebody closes that pane -- which is the next line.
      assert.ok(
        gripterm.gateway.listKnown().some((one) => one.terminalId.value === RESTORED_TERMINAL),
        'the pane with the CLI\'s refusal in it was taken away'
      );

      gripterm.lifecycle.close(entry.terminalId);
      // Waited for by the thing that actually has to have happened, rather than
      // by the state: the record was `ended` before this line -- the CLI's own
      // `SessionEnd` put it there -- so a wait on the state would return at once
      // and `discard` would meet a terminal this window is still holding.
      await gone(gripterm);
      assert.equal(gripterm.lifecycle.discard(entry.terminalId), 'discarded');
    } finally {
      // Reversible by construction: everything here is of this test's making.
      // Delay enough for the writer's own deletion to have gone through, so the
      // two are not racing over the same directory.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await cleanUp(readiness.storageDir);
    }
  });
});
