import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The `resume_failed` branch of П5, in the only configuration that can produce
 * it: a real editor, a real terminal, and a real `claude` that refuses to start.
 *
 * A26 measured that the OBVIOUS failure -- a conversation that is not there --
 * does not end the process under a pty at all, which left this branch reachable
 * only in theory. A27 (2026-08-13) measured which refusals do end it: the ones
 * the CLI makes BEFORE it starts a session. `--mcp-config <a file that is gone>`
 * is the one of those that a record produces by itself, without anybody
 * corrupting anything: the recipe stores absolute paths, and the file behind one
 * of them can be deleted between two sittings.
 *
 * Measured on 2.1.228: exit code 1 after 1178 ms under the editor's own pty.
 *
 * Nothing of the person's is touched. The record is written by this test, owned
 * by a window that never existed, and points at a conversation with no
 * transcript -- so even if the CLI got as far as the resume, it would start
 * nothing. It is removed again in a `finally`, whatever happens.
 */

const FAILING_TERMINAL = '7f8e9d0c-1b2a-4c3d-9e8f-7a6b5c4d3e2f';
/** A conversation that does not exist. The launch never gets far enough to ask for it. */
const ABSENT_SESSION = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const DEAD_WINDOW = 'integration-window-that-closed-p5';
/** The file whose absence is the whole scenario. Its absence is asserted, not assumed. */
const GONE_MCP_CONFIG = join(tmpdir(), 'gripterm-p5-there-is-no-such-mcp.json');

const SETTLES_WITHIN_MS = 30_000;
const POLL_MS = 100;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A record as a window that has since closed would have left it, carrying a task
 * and a note so that the other half of П5 -- what a failed restore LEAVES -- can
 * be read off the same run.
 *
 * Written as JSON rather than through our own encoder, for the reason
 * `shared-base.test.ts` gives: this is the contract as it exists on disk.
 */
function recordJson(now: number): string {
  return JSON.stringify({
    terminalId: FAILING_TERMINAL,
    sessionId: ABSENT_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: DEAD_WINDOW,
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: {
      displayName: 'a restore that cannot start',
      task: 'the task written before the editor was closed',
      notes: [{ text: 'the note written before the editor was closed', at: now }],
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
      mcpConfigPaths: [GONE_MCP_CONFIG],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    createdAt: now,
    closedAt: null,
    revision: 4,
  });
}

function observedJson(now: number): string {
  return JSON.stringify({
    state: 'idle',
    lastEventAt: now,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

/** The record is found by the STRING of its id: `TerminalId` is nominal, see `restore.test.ts`. */
async function stateWithin(gripterm: GriptermApi, wanted: string): Promise<string> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  let seen = 'nothing at all';
  while (Date.now() < deadline) {
    seen = gripterm.registry
      .list()
      .find((one) => one.terminalId.value === FAILING_TERMINAL)?.observed.state ?? 'nothing at all';
    if (seen === wanted) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return seen;
}

/** Everything this test put in the person's store, including what deletion left behind. */
async function cleanUp(storageDir: string): Promise<void> {
  await rm(join(storageDir, 'terminals', FAILING_TERMINAL), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, FAILING_TERMINAL), { recursive: true, force: true });
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

suite('a restore the CLI refuses to start', () => {
  test('ends in resume_failed, with the record and everything on it still there', async () => {
    const gripterm = await api();
    const { repository, restore, readiness } = gripterm;
    assert.ok(repository, 'this window is not reading the shared store');
    assert.ok(restore, 'no orchestrator was composed');

    // The scenario is an absence. Asserted, because a file that happened to
    // exist would turn this into a test of something else entirely.
    await assert.rejects(access(GONE_MCP_CONFIG), 'the mcp config this test needs gone is present');

    const directory = join(readiness.storageDir, 'terminals', FAILING_TERMINAL);
    try {
      await mkdir(directory, { recursive: true });
      const now = Date.now();
      await writeFile(join(directory, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(join(directory, 'record.json'), recordJson(now), 'utf8');

      const entry = (await repository.readAll()).find(
        (one) => one.terminalId.value === FAILING_TERMINAL
      );
      assert.ok(entry, 'the record this test wrote is not readable');

      const report = await restore.run({
        steps: [{ entry, expectedRevision: entry.revision, force: false }],
        skipped: [],
      });
      assert.equal(report.started, 1, JSON.stringify(report.attempts));

      // The measurement: the process exits, and the exit is read as a FAILED
      // RESTORE rather than as an ordinary end -- which is what separates the
      // offer to start over from a row that says nothing (M2.13).
      assert.equal(await stateWithin(gripterm, 'resume_failed'), 'resume_failed');

      // And the terminal is gone with it, which is why the notification for this
      // signal leads to the RECORD and not to a pane: there is no pane.
      assert.equal(
        gripterm.gateway.listKnown().some((one) => one.terminalId.value === FAILING_TERMINAL),
        false,
        'the terminal outlived the process that exited'
      );

      // What the person wrote survives the failure. A restore that lost the task
      // and the notes would fail the promise this extension exists for, and the
      // registry is where the row reads them from.
      const held = gripterm.registry.list().find((one) => one.terminalId.value === FAILING_TERMINAL);
      assert.ok(held, 'the record left the registry');
      assert.equal(held.metadata.task, 'the task written before the editor was closed');
      assert.deepEqual(
        held.metadata.notes.map((note) => note.text),
        ['the note written before the editor was closed']
      );

      assert.equal(gripterm.lifecycle.discard(entry.terminalId), 'discarded');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await cleanUp(readiness.storageDir);
    }
  });
});
