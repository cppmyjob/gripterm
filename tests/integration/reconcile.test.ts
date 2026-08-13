import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { CONTEXT_ABANDONED } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The sweep against a real `owners/` directory.
 *
 * What only a real editor can show here is the thing the unit suite has to
 * double: that the files on disk, the verdict table and the collector agree
 * about one directory. So this test writes a presence file exactly as a window
 * that closed without saying so would have left it, and watches it go.
 *
 * Nothing of the person's is touched. The presence file below belongs to a
 * window that never existed, its name is this suite's own, and it is removed in
 * a `finally` whatever happens. The sweep DOES run against the rest of the
 * store, and that is deliberate rather than overlooked: unlike a restore it can
 * start no process and reach no conversation, everything it removes goes to the
 * trash, and what it collects is by definition rubbish nothing points at.
 */

const DEAD_WINDOW = 'integration-window-that-never-was';
const DEAD_WINDOW_FILE = `${DEAD_WINDOW}.json`;
const ORPHAN_TERMINAL = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const ORPHAN_SESSION = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A presence file whose window is established gone, by arithmetic rather than
 * by a pid.
 *
 * The heartbeat predates the machine's boot, which is the one rule that is
 * deterministic on a test machine: a pid can be reused, refused with `EPERM`, or
 * held by a stranger, and every one of those answers "maybe alive". A moment
 * before the boot cannot have been written by anything running now.
 */
function presenceJson(): string {
  const beforeBoot = Date.now() - uptime() * 1000 - 60_000;
  return JSON.stringify({
    ownerId: DEAD_WINDOW,
    kind: 'window',
    pid: process.pid,
    editorKind: 'vscode',
    editorVersion: '1.133.0',
    workspaceFolders: [],
    startedAt: beforeBoot,
    heartbeatAt: beforeBoot,
  });
}

/**
 * A record of that window's, so that the collector has a reason to keep its
 * file.
 *
 * `closedAt` is a parameter because it decides what the row is: a record whose
 * terminal is still open can be taken over, and one whose terminal a person
 * closed cannot -- which is the row M2.22 is about.
 */
function recordJson(now: number, closedAt: number | null = null): string {
  return JSON.stringify({
    terminalId: ORPHAN_TERMINAL,
    sessionId: ORPHAN_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: DEAD_WINDOW,
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: {
      displayName: 'a terminal of a window that never was',
      task: null,
      notes: [],
      tags: [],
      color: null,
    },
    launch: {
      cwd: process.cwd(),
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
    closedAt,
    revision: 1,
  });
}

/**
 * Waits for the base projection to catch up with a file this test just wrote.
 *
 * The path from a record on disk to a row is `fs.watch` -> debounce ->
 * `readAll()` -> `replaceForeign` (§4.6), and every part of it is asynchronous
 * on purpose. Polling is what a test may do about that; a fixed sleep would
 * either be flaky or be the whole debounce spent on every run.
 */
async function awaitRow<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = read();
    if (found !== undefined) {
      return found;
    }
    assert.ok(Date.now() < deadline, `${what} never reached this window`);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
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

/** Where the collector puts what it takes, wherever under `trash/` it landed. */
async function collectedFile(storageDir: string): Promise<string | null> {
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    const candidate = join(trash, stamp, 'owners', DEAD_WINDOW_FILE);
    const found = await readFile(candidate, 'utf8').then(() => candidate).catch(() => null);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Which rows the manifest offers `gripterm.deleteTerminal` on -- read out of the
 * host rather than written down here, so that this test compares the row the
 * list DRAWS with the menu the editor would show on it.
 */
function deletableRows(): readonly string[] {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension);
  const manifest = extension.packageJSON as {
    contributes: { menus: Record<string, { command: string, when: string }[]> };
  };
  return (manifest.contributes.menus['view/item/context'] ?? [])
    .filter((item) => item.command === 'gripterm.deleteTerminal')
    .map((item) => /viewItem == ([\w.]+)/u.exec(item.when)?.[1] ?? '');
}

async function cleanUp(storageDir: string): Promise<void> {
  await rm(join(storageDir, 'owners', DEAD_WINDOW_FILE), { force: true });
  await rm(join(storageDir, 'terminals', ORPHAN_TERMINAL), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, 'owners', DEAD_WINDOW_FILE), { force: true });
    await rm(join(trash, stamp, ORPHAN_TERMINAL), { recursive: true, force: true });
    // The `owners/` directory the collector made goes too when this test's file
    // was all it held -- otherwise the store keeps an empty folder per run.
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

suite('reconciling with the machine', () => {
  test('a window is composed with a sweep when it shares the base', async () => {
    const { reconciler, readiness } = await api();

    assert.equal(reconciler !== null, readiness.sharing);
  });

  test('the file of a window that is gone is kept while a record names it, and collected once none does', async () => {
    const gripterm = await api();
    const { reconciler, readiness } = gripterm;
    assert.ok(reconciler, 'this window is not reading the shared store');

    const owners = join(readiness.storageDir, 'owners');
    const terminal = join(readiness.storageDir, 'terminals', ORPHAN_TERMINAL);
    try {
      const now = Date.now();
      await mkdir(owners, { recursive: true });
      await mkdir(terminal, { recursive: true });
      await writeFile(join(owners, DEAD_WINDOW_FILE), presenceJson(), 'utf8');
      await writeFile(join(terminal, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(join(terminal, 'record.json'), recordJson(now), 'utf8');

      // The window is established dead -- and its file stays, because a record
      // still points at it and `dead` is the answer that authorises adoption.
      const kept = await reconciler.sweep();
      assert.equal(kept.collected.includes(DEAD_WINDOW), false, JSON.stringify(kept));
      assert.equal(reconciler.livenessOf(gripterm.identity.ownerId), 'live');
      assert.equal(await collectedFile(readiness.storageDir), null);

      // The record goes -- as a person deleting it, or another window adopting
      // it, would take it -- and now nothing depends on the answer any more.
      await rm(terminal, { recursive: true, force: true });
      const swept = await reconciler.sweep();

      assert.equal(swept.collected.includes(DEAD_WINDOW), true, JSON.stringify(swept));
      // In the trash rather than deleted: the way back is a move (§I.3).
      const discarded = await collectedFile(readiness.storageDir);
      assert.ok(discarded !== null, 'the collected file is nowhere under trash/');
      assert.match(await readFile(discarded, 'utf8'), new RegExp(DEAD_WINDOW, 'u'));
    } finally {
      await cleanUp(readiness.storageDir);
    }
  });

  /*
   * M2.22, and the whole chain the owner's complaint runs through: a record on
   * disk, a window that is gone, the sweep's verdict, the presenter, the row --
   * and then the manifest, which is where it used to end in nothing.
   *
   * It lives here rather than beside the other view tests because a row of a
   * window that is GONE is what this file already knows how to build, and the
   * fixture is the expensive half.
   *
   * The record is closed on purpose, which is the case that had no way out at
   * all: it cannot be taken over -- there is nothing to resume -- and its window
   * will never come back to delete it. The last assertion is the one that
   * matters: whatever value the list draws such a row with, the manifest must
   * offer deletion on THAT value. A test naming the value on both sides would
   * have stayed green through the defect.
   */
  test('leaves a person a way out of a record whose window closed for good', async () => {
    const gripterm = await api();
    const { reconciler, readiness, registry, tree } = gripterm;
    assert.ok(reconciler, 'this window is not reading the shared store');

    const owners = join(readiness.storageDir, 'owners');
    const terminal = join(readiness.storageDir, 'terminals', ORPHAN_TERMINAL);
    try {
      const now = Date.now();
      await mkdir(owners, { recursive: true });
      await mkdir(terminal, { recursive: true });
      await writeFile(join(owners, DEAD_WINDOW_FILE), presenceJson(), 'utf8');
      await writeFile(join(terminal, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(join(terminal, 'record.json'), recordJson(now, now), 'utf8');
      await reconciler.sweep();

      const entry = await awaitRow(
        () => registry.list().find((one) => one.terminalId.value === ORPHAN_TERMINAL),
        'the record of a window that is gone'
      );
      const drawn = String(tree.getTreeItem(entry).contextValue);

      assert.equal(drawn, CONTEXT_ABANDONED, `the row of an abandoned record is drawn ${drawn}`);
      assert.ok(
        deletableRows().includes(drawn),
        `nothing in the row menu of a ${drawn} row removes it`
      );
    } finally {
      await cleanUp(readiness.storageDir);
    }
  });

  test('this window stays live to itself however often the machine is swept', async () => {
    // The wake-from-sleep rule, in the one place its opposite would be visible:
    // if the sweep ever believed the medium about this window, every row it
    // draws would turn `detached` while the terminals ran.
    const gripterm = await api();
    const { reconciler } = gripterm;
    assert.ok(reconciler, 'this window is not reading the shared store');

    await reconciler.sweep();

    assert.equal(reconciler.livenessOf(gripterm.identity.ownerId), 'live');
    assert.equal(reconciler.liveness().get(gripterm.identity.ownerId.value), 'live');
  });
});
