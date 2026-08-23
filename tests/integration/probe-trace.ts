import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * Does the pid we write down outlive the conversation it names?
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The customer's log, 2026-08-22, and the line that ends the guessing:**
 *
 *   09:11:00  a terminal was found without its process {"pid":32496}
 *   09:11:10  a terminal could not be resumed
 *             {"cause":"ConflictError: this terminal is already running"}
 *
 * Ten seconds apart. The sweep said the process was gone; the window still held
 * a running terminal for the same record. One of the two is wrong, and the
 * second one is the window's own hand: it HAS the terminal object.
 *
 * The pid comes from `Terminal.processId`, which is the process the editor
 * started as the shell -- with `gripterm.launch.mode: process` that is
 * `claude.EXE`. If that executable is a launcher which starts something else
 * and exits, the pid we wrote down dies within seconds while the conversation
 * goes on, and every sweep after that declares the record orphaned. The row
 * then says `no process` about an agent that is answering, which is the
 * customer's "долго статус изменяется" seen from the other side: it changes to
 * the WRONG thing, on the sweep's schedule.
 *
 * This probe starts one real agent and watches both numbers for a minute.
 */

const RECIPE_TERMINAL = '7a7a7a7a-1b1b-4c4c-8d8d-2e2e2e2e2e2e';
const RECIPE_SESSION = '8b8b8b8b-1b1b-4c4c-8d8d-2e2e2e2e2e2e';

type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function recipeJson(now: number): string {
  return JSON.stringify({
    terminalId: RECIPE_TERMINAL,
    sessionId: RECIPE_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: 'a-window-that-lent-a-recipe-to-the-pid-probe',
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: { displayName: 'a record lent for its recipe', task: null, notes: [], tags: [], color: null },
    launch: {
      cwd: os.tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    engine: 'editor',
    createdAt: now,
    closedAt: null,
    revision: 1,
  });
}

function noProcessJson(now: number): string {
  return JSON.stringify({
    state: 'ended',
    lastEventAt: now,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

async function recipeFromStore(gripterm: GriptermApi): Promise<Entry['launch']> {
  const { repository, readiness } = gripterm;
  assert.ok(repository, 'this window is not reading the shared store');
  const directory = join(readiness.storageDir, 'terminals', RECIPE_TERMINAL);
  try {
    const now = Date.now();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), recipeJson(now), 'utf8');
    await writeFile(join(directory, 'observed.json'), noProcessJson(now), 'utf8');
    const entry = (await repository.readAll()).find((one) => one.terminalId.value === RECIPE_TERMINAL);
    assert.ok(entry, 'the scaffold record this probe wrote is not readable');
    return entry.launch;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

suite('what a start leaves on disk', () => {
  test('starts.jsonl beside the record', async () => {
    const gripterm = await api();
    const { lifecycle, registry, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this probe starts a real one');

    const started = await lifecycle.launch({
      displayName: 'the probe of the trace',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    try {
      await pause(6000);
      const file = join(readiness.storageDir, 'terminals', terminalId.value, 'starts.jsonl');
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(file, 'utf8').catch((cause: unknown) => `COULD NOT READ: ${String(cause)}`);
      console.log(`  ${file}`);
      for (const line of text.split('\n').filter((one) => one.trim().length > 0)) {
        console.log(`    ${line}`);
      }
      console.log(`  the record says pid=${String(registry.get(terminalId)?.observed.pid)}`);
    } finally {
      lifecycle.close(terminalId);
      await pause(1500);
      lifecycle.discard(terminalId);
      await pause(1000);
      await rm(join(readiness.storageDir, 'terminals', terminalId.value), { recursive: true, force: true });
    }
  });
});
