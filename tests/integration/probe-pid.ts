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

const RECIPE_TERMINAL = '2c2c2c2c-1b1b-4c4c-8d8d-2e2e2e2e2e2e';
const RECIPE_SESSION = '3d3d3d3d-1b1b-4c4c-8d8d-2e2e2e2e2e2e';

type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** `kill(pid, 0)`: no signal is sent, and the answer is whether it could have been. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return (cause as { code?: string }).code === 'EPERM';
  }
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

suite('the pid a record carries', () => {
  test('does it outlive the conversation', async () => {
    const gripterm = await api();
    const { lifecycle, gateway, registry, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this probe starts a real one');
    console.log(`  the cli is ${String(readiness.cliPath)}`);

    const started = await lifecycle.launch({
      displayName: 'the probe of the pid',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    try {
      const handle = gateway.handleFor(terminalId);
      assert.ok(handle, 'the gateway does not hold the terminal it just made');
      const shell = await handle.processId();
      console.log(`  the editor says the terminal's process is ${String(shell)}`);

      const began = Date.now();
      let recorded: number | null = null;
      let died: number | null = null;
      for (let tick = 1; tick <= 60; tick += 1) {
        await pause(1000);
        const entry = registry.get(terminalId);
        const pid = entry?.observed.pid ?? null;
        if (pid !== null && recorded === null) {
          recorded = pid;
          console.log(`  +${String(Date.now() - began)} ms  the record took the pid ${String(pid)}`);
        }
        if (recorded !== null && died === null && !alive(recorded)) {
          died = Date.now();
          console.log(`  +${String(died - began)} ms  THE PID IS GONE while the window still holds the terminal:`
            + ` handle=${String(gateway.handleFor(terminalId) !== undefined)},`
            + ` state=${String(entry?.observed.state)}`);
        }
        if (tick % 10 === 0) {
          console.log(`  +${String(Date.now() - began)} ms  state=${String(entry?.observed.state)},`
            + ` pid=${String(pid)}, alive=${String(recorded === null ? 'n/a' : alive(recorded))},`
            + ` shellAlive=${String(shell === null ? 'n/a' : alive(shell))},`
            + ` terminals=${String(vscode.window.terminals.length)}`);
        }
      }
      console.log(`  the shell process ${String(shell)} is ${alive(shell ?? 1) ? 'alive' : 'GONE'} at the end`);
    } finally {
      lifecycle.close(terminalId);
      await pause(1500);
      lifecycle.discard(terminalId);
      await pause(1000);
      await rm(join(readiness.storageDir, 'terminals', terminalId.value), { recursive: true, force: true });
    }
  });
});
