import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_OVER, presentTerminal } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The owner's own moves, timed, in the editor the owner uses.
 *
 * Not a test and not part of any gate -- the file is deliberately not named
 * `*.test.ts`, which is what the two runs in `.vscode-test.mjs` glob for. It is
 * started by hand through `spikes/cursor-probe` and what it produces is a
 * transcript to read.
 *
 * **The owner, 2026-08-22, two reports in one message.** The first: a window
 * with an empty editor area, `+` in the list, and "он делит область с файлами
 * -- если кликнуть на файл, то справа от терминала появляется файл". The
 * second: "если закрыть через таб терминал, то в Claude Code Terminals этот
 * терминал долго очень остаётся активным -- до минуты".
 *
 * So there are two questions and both are about TIME, which is why neither of
 * the suites already written can answer them: they wait for the right answer
 * for as long as twenty seconds and then pass. A row that takes fifty seconds
 * to stop claiming a running agent passes every one of them.
 */

const RECIPE_TERMINAL = '7c7c7c7c-1b1b-4c4c-8d8d-2e2e2e2e2e2e';
const RECIPE_SESSION = '6d6d6d6d-1b1b-4c4c-8d8d-2e2e2e2e2e2e';

type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function kindOf(tab: vscode.Tab): string {
  if (tab.input instanceof vscode.TabInputTerminal) {
    return 'terminal';
  }
  if (tab.input instanceof vscode.TabInputText) {
    return 'file';
  }
  return 'other';
}

function groups(): string {
  return vscode.window.tabGroups.all
    .map((group) => {
      const held = group.tabs.map((tab) => `${kindOf(tab)}:${tab.label}`).join(', ');
      const active = group.isActive ? '*' : ' ';
      return `[${String(group.viewColumn)}${active}] ${held === '' ? '(empty)' : held}`;
    })
    .join('  |  ');
}

async function snap(label: string): Promise<void> {
  const layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
  console.log(`  ${label}\n      groups: ${groups()}\n      layout: ${JSON.stringify(layout)}`);
}

/** The column holding terminals and nothing else, or `null`. */
function stripColumn(): vscode.ViewColumn | null {
  const strip = vscode.window.tabGroups.all.find(
    (group) => group.tabs.length > 0 && group.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal)
  );
  return strip?.viewColumn ?? null;
}

function rowFor(gripterm: GriptermApi, terminalId: Entry['terminalId']): {
  readonly state: string;
  readonly contextValue: string;
} | null {
  const entry = gripterm.registry.list().find((one) => one.terminalId.equals(terminalId));
  if (entry === undefined) {
    return null;
  }
  const shown = presentTerminal(entry, { ours: gripterm.registry.knows(terminalId) });
  return { state: shown.state, contextValue: shown.contextValue };
}

function recipeJson(now: number): string {
  return JSON.stringify({
    terminalId: RECIPE_TERMINAL,
    sessionId: RECIPE_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: 'a-window-that-lent-a-recipe-to-the-owner-probe',
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

async function scrub(gripterm: GriptermApi, terminalId: Entry['terminalId']): Promise<void> {
  const { registry, lifecycle, readiness } = gripterm;
  if (registry.knows(terminalId)) {
    lifecycle.close(terminalId);
    await pause(1200);
    lifecycle.discard(terminalId);
  }
  await pause(1000);
  await rm(join(readiness.storageDir, 'terminals', terminalId.value), { recursive: true, force: true });
}

suite('the moves the owner made, timed', () => {
  test('A. the plus on an empty editor area, and then a file', async () => {
    const gripterm = await api();
    const { lifecycle, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this probe starts a real one');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(800);
    await snap('an editor area with nothing in it, which is where the owner starts');

    const started = await lifecycle.launch({
      displayName: 'the probe of the first move',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    try {
      for (let tick = 1; tick <= 10; tick += 1) {
        await pause(300);
        await snap(`+${String(tick * 300)} ms after the terminal was asked for`);
      }

      const before = vscode.window.tabGroups.all.length;
      const strip = stripColumn();
      console.log(`  the strip is column ${String(strip)}, and there are ${String(before)} groups`);

      const file = vscode.Uri.file(join(readiness.storageDir, 'a-file-the-owner-clicks.txt'));
      await writeFile(file.fsPath, 'the file a person clicks in the explorer\n', 'utf8');
      await vscode.commands.executeCommand('vscode.open', file);
      await pause(1200);
      await snap('after the file was opened, which is the move the owner says goes wrong');

      const holding = vscode.window.tabGroups.all.find((group) =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputText)
      );
      console.log(`  the file landed in column ${String(holding?.viewColumn)}; groups went ${String(before)} -> ${String(vscode.window.tabGroups.all.length)}`);
      assert.ok(holding, 'the file did not open at all');
      assert.notEqual(holding.viewColumn, strip, 'the file went into the strip');
      assert.equal(
        vscode.window.tabGroups.all.length,
        before,
        'the editor had to MAKE a group for the file, which is the trap: there was nowhere to put it'
      );
      await rm(file.fsPath, { force: true });
    } finally {
      await scrub(gripterm, terminalId);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('B. how long the row goes on claiming a running agent after the cross', async () => {
    const gripterm = await api();
    const { lifecycle, gateway, registry, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this probe starts a real one');

    const started = await lifecycle.launch({
      displayName: 'the probe of the second move',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    const editorSaid: { at: number | null } = { at: null };
    const heard = vscode.window.onDidCloseTerminal(() => {
      editorSaid.at ??= Date.now();
    });
    try {
      const until = Date.now() + 20_000;
      while (registry.get(terminalId) === undefined && Date.now() < until) {
        await pause(100);
      }
      // Let the agent get going, the way a person who opened one would.
      await pause(4000);
      const handle = gateway.handleFor(terminalId);
      assert.ok(handle, 'the gateway does not hold the terminal it just made');
      handle.show(false);
      await pause(1000);
      console.log(`  before the cross: ${JSON.stringify(rowFor(gripterm, terminalId))}`);

      const pressed = Date.now();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      let seen = '';
      const settled: { at: number | null } = { at: null };
      const deadline = pressed + 90_000;
      while (Date.now() < deadline) {
        const row = rowFor(gripterm, terminalId);
        const now = `${String(row?.state)}/${String(row?.contextValue)}`;
        if (now !== seen) {
          seen = now;
          console.log(`  +${String(Date.now() - pressed)} ms  ${now}`);
        }
        if (row !== null && row.contextValue === CONTEXT_OVER) {
          settled.at = Date.now();
          break;
        }
        await pause(50);
      }
      const heardIn = editorSaid.at === null ? 'NEVER' : `${String(editorSaid.at - pressed)} ms`;
      console.log(`  the editor said the terminal closed after ${heardIn}`);
      const took = settled.at === null ? 'NEVER (90 s)' : `${String(settled.at - pressed)} ms`;
      console.log(`  the row stopped claiming an agent after ${took}`);
      assert.notEqual(settled.at, null, 'the row never stopped claiming a running agent');
    } finally {
      heard.dispose();
      await scrub(gripterm, terminalId);
    }
  });
});
