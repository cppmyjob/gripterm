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
        steps: [{ entry, expectedRevision: entry.revision, force: false, intent: 'resume' }],
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
       * And stamped with the engine that ANSWERED, which is where the second run
       * of M3.10 gets its teeth on the restore path. The engine goes into the
       * record from the gateway that just made the terminal (M3.4) rather than
       * from the setting, so this line says the same true thing under both runs
       * -- and fails the moment a run under `own` is quietly the editor's run,
       * because then every record it writes says `editor`.
       *
       * It is not bookkeeping: reconciliation reads this field to decide whose
       * processes it may end. A record saying `own` for a terminal the editor
       * made hands a live conversation to the sweep (M2.16).
       */
      assert.equal(
        gripterm.registry.get(entry.terminalId)?.engine,
        gripterm.readiness.engine,
        'the record was stamped with an engine this window is not on'
      );

      /*
       * **This line has been three different states, and each move was a
       * measurement rather than an opinion.** It is worth reading in order,
       * because the register entries it belongs to are A26, A44 and A45.
       *
       * `degraded` (M2.11): `claude --resume <a conversation that is not there>`
       * was observed to print its refusal and STAY under a pty, so the end of a
       * failed resume was the twenty-second wait rather than an exit.
       *
       * `ended` (2026-08-17, M3.5): re-measured three ways, because this test
       * failing is not by itself evidence of anything. Under our own pty the CLI
       * prints `No conversation found with session ID: <id>` and EXITS WITH 1
       * after some 3.4 s (A44); the editor reports that exit as
       * `{code: 1, reason: 'user'}`, which is A29's own row; and the run was
       * proved not to be that step's doing by stashing every change of M3.5 and
       * watching a clean tree fail identically. Why `ended` and not
       * `resume_failed` was measured too, by instrumenting the lifecycle: a
       * `SessionEnd` hook arrives BEFORE the editor reports the close, so by the
       * time `deathEvent` asked, the record was already at a witnessed end and
       * the exit code that would have made it `resume_failed` was never read.
       * The cost was stated here rather than left green: `resume_failed` is the
       * state M2.13 turns into an offer to start the conversation over, and this
       * path did not reach it.
       *
       * `resume_failed` (2026-08-20, A45 closed): the order was measured on CLI
       * 2.1.233 with every hook name pointed at one sink -- `SessionEnd` at
       * about 1.6 s carrying `reason: "other"`, which is also the value an
       * unrecognised one collapses into, and the exit at about 3.15 s with code
       * 1. Since the payload cannot tell this end from an ordinary one, the
       * ORDER is all there is, and the state machine now refuses `SessionEnd`
       * while a record is still `launching`: there and only there, "the CLI shut
       * down" and "the start got going" are different questions. So the exit
       * code arrives at a record that is still asking, and the offer to start
       * over exists on the path that needs it most.
       */
      assert.equal(await stateWithin(gripterm, 'resume_failed'), 'resume_failed');

      // And the terminal went with the process. This is the other half of what
      // the A45 fix moved, and it is asserted rather than assumed: the record
      // now settles on the EXIT CODE, and the exit code reaches us as the editor
      // saying the terminal object is gone -- so `resume_failed` and "there is
      // no pane any more" are one instant by construction. It is why the toast
      // for this signal leads to the ROW and not to a pane (M2.13), and it is
      // the same assertion `resume-failed.test.ts` makes on its own path.
      //
      // Until 2026-08-20 this line said the OPPOSITE and was honest then: the
      // record settled on the `SessionEnd` hook some 1.5 s before the process
      // exited, so the check ran while the pane was still up.
      assert.equal(
        gripterm.gateway.listKnown().some((one) => one.terminalId.value === RESTORED_TERMINAL),
        false,
        'the terminal outlived the process that exited'
      );
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
