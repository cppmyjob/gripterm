import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The claim M2.5 exists to make: a change another window makes to the shared
 * store shows up here, without polling.
 *
 * It cannot be made anywhere but in a real editor. The watcher's own tests use
 * an injected platform, and a unit test can prove every rule about a platform
 * event except the one that matters most -- that the event arrives at all,
 * through a real recursive `fs.watch`, in the host this extension actually runs
 * in.
 *
 * "Another window" here is a directory with a record in it, owned by an owner id
 * that is not ours. That IS what another window is: the store has no other way
 * of knowing one, and there is no second editor to start.
 */

const FOREIGN_TERMINAL = '0d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const FOREIGN_OWNER = 'integration-foreign-window';

/** Long enough for a debounce (200 ms) and a read, short enough to fail a broken build fast. */
const APPEARS_WITHIN_MS = 8000;
const POLL_MS = 50;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A record as another window would have written it.
 *
 * Written as JSON rather than through the repository on purpose: this is the
 * contract as it exists ON DISK, and a test that produced it with our own
 * encoder could not tell the two apart.
 */
function recordJson(now: number): string {
  return JSON.stringify({
    terminalId: FOREIGN_TERMINAL,
    sessionId: '3f2b1a09-8c7d-4e6f-9a0b-1c2d3e4f5a6b',
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: FOREIGN_OWNER,
      editorKind: 'vscode',
      workspaceFolder: 'D:/Projects/elsewhere',
    },
    metadata: {
      displayName: 'a terminal in another window',
      task: null,
      notes: [],
      tags: [],
      color: null,
    },
    launch: {
      cwd: 'D:/Projects/elsewhere',
      addDirs: [],
      permissionMode: 'manual',
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    createdAt: now,
    closedAt: null,
    revision: 1,
  });
}

function observedJson(now: number): string {
  return JSON.stringify({
    state: 'working',
    lastEventAt: now,
    currentTool: 'Bash',
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

async function waitUntil(wanted: boolean, gripterm: GriptermApi, what: string): Promise<void> {
  const deadline = Date.now() + APPEARS_WITHIN_MS;
  while (Date.now() < deadline) {
    const there = gripterm.registry.list().some((entry) => entry.terminalId.value === FOREIGN_TERMINAL);
    if (there === wanted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`${what} did not happen within ${APPEARS_WITHIN_MS} ms`);
}

suite('the store other windows share', () => {
  test('this window announced itself, and the file says who it is', async () => {
    const { identity, readiness } = await api();
    assert.equal(readiness.sharing, true, 'this window is not reading the shared store at all');

    const raw = await readFile(
      join(readiness.storageDir, 'owners', `${identity.ownerId.value}.json`),
      'utf8'
    );
    const presence = JSON.parse(raw) as { pid: number, heartbeatAt: number };

    // The pid is the one adoption asks the operating system about. A wrong one
    // means a living window declared dead and its terminals restored under it.
    assert.equal(presence.pid, process.pid);
    assert.ok(
      Math.abs(presence.heartbeatAt - Date.now()) < 120_000,
      'the heartbeat in the file is not from this run'
    );
  });

  test('a record another window writes appears in this list, and leaving takes it away', async () => {
    const gripterm = await api();
    const { registry } = gripterm;
    const directory = join(gripterm.readiness.storageDir, 'terminals', FOREIGN_TERMINAL);

    try {
      await mkdir(directory, { recursive: true });
      const now = Date.now();
      // The observed half first and the record last, which is the order the
      // repository writes them in: a reader that saw the record first could
      // find a snapshot that had not arrived yet.
      await writeFile(join(directory, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(join(directory, 'record.json'), recordJson(now), 'utf8');

      await waitUntil(true, gripterm, 'the row from the other window appearing');

      // Projected, not held: the commands this window offers must not reach a
      // record it may not write.
      const shown = registry.list().find((entry) => entry.terminalId.value === FOREIGN_TERMINAL);
      assert.ok(shown, 'the row is in the list');
      assert.equal(shown.metadata.displayName, 'a terminal in another window');
      assert.equal(shown.observed.state, 'working');
      assert.equal(registry.knows(shown.terminalId), false);
      assert.equal(registry.get(shown.terminalId), undefined);
      assert.ok(
        !registry.own().some((entry) => entry.terminalId.value === FOREIGN_TERMINAL),
        'a foreign row must not reach the pickers or the status bar'
      );
    } finally {
      // Reversible by construction: a directory of our own making, removed
      // whatever happened above. Everything else in this store belongs to the
      // person running the suite.
      await rm(directory, { recursive: true, force: true });
    }

    // The other half of the same claim, and the reason this wait is not merely
    // tidiness: a record that vanishes from the base must vanish from the list,
    // or the window keeps offering a terminal that no longer exists. It also
    // leaves the suite the way it found it, for the tests that run after.
    await waitUntil(false, gripterm, 'the row disappearing again');
  });
});
