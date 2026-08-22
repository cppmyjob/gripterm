import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_OVER, presentTerminal, processGone } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * What a person is left with after they close one of our terminals.
 *
 * **The customer, 2026-08-22:** "при их закрытии в панели они остаются в
 * treeview и удалить их нельзя никакими способами -- только может быть после
 * перезагрузки они сами удаляются."
 *
 * The row STAYING is the design: a conversation that is over keeps its record
 * so that its journal, its notes and `Start Over` are still there. What must
 * not survive the close is the row's claim to be a running terminal -- that
 * claim is what the manifest keys `Delete Record` on, and a row still wearing
 * `gripterm.terminal.live` offers Close, Rename and Focus and no way at all to
 * be rid of it.
 *
 * So this suite closes a terminal the two ways a person can, and asks what the
 * list would draw afterwards. It is deliberately asserted through
 * `presentTerminal().contextValue` rather than through the state: the state is
 * not what the person meets, the `contextValue` is what every menu is keyed on.
 *
 * Measured under both editors on 2026-08-22 -- VS Code stable and the Cursor on
 * this machine -- and both were honest. Written down as a suite all the same,
 * because the customer's report is about this act and a build that stops being
 * honest about it must fail rather than be argued about.
 */

const RECIPE_TERMINAL = '9a9a9a9a-1b1b-4c4c-8d8d-2e2e2e2e2e2e';
const RECIPE_SESSION = '8b8b8b8b-1b1b-4c4c-8d8d-2e2e2e2e2e2e';

type Spec = Parameters<GriptermApi['gateway']['create']>[0];
type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

const GROUP_TERMINAL_A = { value: '11111111-2222-4333-8444-555555555555' } as unknown as Spec['terminalId'];
const GROUP_TERMINAL_B = { value: '22222222-3333-4444-8555-666666666666' } as unknown as Spec['terminalId'];

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(what: string, ready: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`waited ${String(ms)} ms for ${what}`);
    }
    await pause(100);
  }
}

/** How many tabs in the window carry that name. */
function tabsNamed(name: string): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label.includes(name)).length;
}

function describeGroups(): string {
  return vscode.window.tabGroups.all
    .map((group) => {
      const held = group.tabs.map((tab) => tab.label).join(', ');
      return `[${String(group.viewColumn)}] ${held === '' ? '(empty)' : held}`;
    })
    .join(' | ');
}

/** What the list would draw for that record, or `null` once there is no row. */
function rowFor(gripterm: GriptermApi, terminalId: Entry['terminalId']): {
  readonly state: string;
  readonly contextValue: string;
  readonly closed: boolean;
} | null {
  const entry = gripterm.registry.list().find((one) => one.terminalId.equals(terminalId));
  if (entry === undefined) {
    return null;
  }
  const shown = presentTerminal(entry, { ours: gripterm.registry.knows(terminalId) });
  return { state: shown.state, contextValue: shown.contextValue, closed: entry.closedAt !== null };
}

function recipeJson(now: number): string {
  return JSON.stringify({
    terminalId: RECIPE_TERMINAL,
    sessionId: RECIPE_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: 'a-window-that-lent-a-recipe-to-the-closing-suite',
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

/**
 * A launch recipe, read back out of the store rather than built.
 *
 * `LaunchRecipe` is a class of the core, and a compiled integration suite
 * cannot reach the core's constructors -- an installed extension has no
 * `node_modules` to resolve `@gripterm/core` through. What it can do is read
 * one back through the repository this window is using. The scaffold is removed
 * before this returns, so nothing of the suite's making is in the store while a
 * real terminal of its own is running.
 */
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
    assert.ok(entry, 'the scaffold record this suite wrote is not readable');
    return entry.launch;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

suite('the row a closed terminal leaves behind', () => {
  test('the cross on the tab leaves a record a person can delete', async () => {
    const gripterm = await api();
    const { registry, lifecycle, gateway, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this suite starts a real one');

    // A real agent through the composed lifecycle, which is the path the button
    // takes. It is never spoken to: it costs a conversation in the CLI's own
    // store and no tokens.
    const started = await lifecycle.launch({
      displayName: 'a terminal closed on its tab',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    try {
      await waitFor('the record to exist', () => registry.get(terminalId) !== undefined);
      const handle = gateway.handleFor(terminalId);
      assert.ok(handle, 'the gateway does not hold the terminal it just made');

      // `closeActiveEditor` on the terminal's own tab: the cross, in the one
      // form a run can press.
      handle.show(false);
      await waitFor(
        'the terminal to be the editor in front',
        () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal
      );
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      await waitFor('the record to hear that its terminal is gone', () => {
        const row = rowFor(gripterm, terminalId);
        return row !== null && row.contextValue === CONTEXT_OVER;
      });

      const row = rowFor(gripterm, terminalId);
      assert.ok(row, 'the record went away entirely, which is not what a close does');
      assert.equal(row.state, 'ended');
      assert.equal(row.closed, true, 'a terminal closed by the person was left restorable');
      // The whole point: this is the value `Delete Record` is keyed on.
      assert.equal(row.contextValue, CONTEXT_OVER);
      assert.equal(lifecycle.discard(terminalId), 'discarded');
      assert.equal(rowFor(gripterm, terminalId), null, 'the row survived being deleted');
    } finally {
      if (registry.knows(terminalId)) {
        lifecycle.close(terminalId);
        await pause(1000);
        lifecycle.discard(terminalId);
      }
      await pause(1500);
      await rm(join(readiness.storageDir, 'terminals', terminalId.value), { recursive: true, force: true });
    }
  });

  test('a record whose process is gone can be deleted although its pane is still there', async () => {
    /*
     * The owner, 2026-08-22, in three moves: open a terminal, close it without
     * typing anything, wait until the row says `no process`, press Delete. The
     * answer was "Gripterm: close this terminal before deleting its record" --
     * on a row whose menu offers Delete and does NOT offer Close.
     *
     * The reconciler's own act is what puts a record into `orphaned`, so this
     * suite performs it directly rather than waiting thirty seconds for a sweep
     * whose subject is somewhere else. What only a live host can answer is the
     * half after the decision: a pane taken with the record really leaves the
     * editor.
     */
    const gripterm = await api();
    const { registry, lifecycle, readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this suite starts a real one');

    const started = await lifecycle.launch({
      displayName: 'a terminal whose process went without saying so',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    let deleted = false;
    try {
      await waitFor('the record to exist', () => registry.get(terminalId) !== undefined);
      await waitFor('the terminal to get a tab', () => tabsNamed(started.metadata.displayName) === 1);

      registry.ingest(terminalId, processGone(null));
      const row = rowFor(gripterm, terminalId);
      assert.ok(row);
      assert.equal(row.state, 'orphaned', 'the record did not reach the state the person was looking at');
      assert.equal(row.contextValue, CONTEXT_OVER, 'the row was not the one that offers Delete');

      const outcome = lifecycle.discard(terminalId);
      assert.equal(
        outcome,
        'discarded',
        `the deletion answered ${outcome} on a row whose menu has no Close on it`
      );
      deleted = true;

      assert.equal(rowFor(gripterm, terminalId), null, 'the row survived being deleted');
      await waitFor(
        `the pane to go with the record: ${describeGroups()}`,
        () => tabsNamed(started.metadata.displayName) === 0
      );
    } finally {
      if (!deleted && registry.knows(terminalId)) {
        lifecycle.close(terminalId);
        await pause(1000);
        lifecycle.discard(terminalId);
      }
      await pause(1500);
      await rm(join(readiness.storageDir, 'terminals', terminalId.value), { recursive: true, force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('the editor names every terminal when a whole group is taken away', async () => {
    /*
     * The other way out of the shape the customer could not get out of: rather
     * than close the tabs one by one, close the group. If the editor named only
     * the terminal that happened to be in front, every other record in that
     * group would keep claiming to be running -- with no terminal behind it,
     * no Delete on its menu, and no way to be rid of it but a restart.
     */
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(500);

    const told: string[] = [];
    const watching = vscode.window.onDidCloseTerminal((terminal) => {
      told.push(terminal.name);
    });
    const first = await gateway.create({
      terminalId: GROUP_TERMINAL_A,
      name: 'gripterm-closing-a',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    const second = await gateway.create({
      terminalId: GROUP_TERMINAL_B,
      name: 'gripterm-closing-b',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      /*
       * OURS by name, not "a group with two terminals in it". The first draft
       * counted, and on 2026-08-22 it closed a group holding one of ours and a
       * `pwsh` left behind by an earlier suite -- so the failure said `pwsh`
       * where it meant "this run had a stranger in the room". What the suite is
       * about is that the editor names EVERY terminal of a closed group, and a
       * stranger in the same group does not make that less true.
       */
      const holds = (group: vscode.TabGroup, name: string): boolean =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal && tab.label.includes(name));
      await waitFor(
        `both terminals to get tabs: ${describeGroups()}`,
        () => vscode.window.tabGroups.all.some((group) =>
          holds(group, 'gripterm-closing-a') && holds(group, 'gripterm-closing-b'))
      );
      const group = vscode.window.tabGroups.all.find((one) =>
        holds(one, 'gripterm-closing-a') && holds(one, 'gripterm-closing-b'));
      assert.ok(group, `the two terminals are not in one group: ${describeGroups()}`);

      await vscode.window.tabGroups.close(group, false);

      await waitFor(
        `the editor to name both terminals, and it named ${told.join(', ')}`,
        () => told.includes('gripterm-closing-a') && told.includes('gripterm-closing-b')
      );
    } finally {
      watching.dispose();
      first.dispose();
      second.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await pause(500);
    }
  });
});
