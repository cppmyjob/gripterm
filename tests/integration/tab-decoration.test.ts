import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WRITE_DEBOUNCE_MS,
  HumanMetadata,
  LaunchRecipe,
  ObservedState,
  SessionId,
  TerminalEntry,
  TerminalId,
  ownerRefFor,
  presentTerminal,
  type OwnerIdentity,
  type PersistedTerminalState,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The state of an agent on the tab of its terminal.
 *
 * **The customer's third complaint, 2026-08-21:** "Иконка статуса не
 * отображается в табе терминала, но отображается в treeview."
 *
 * WHAT is drawn for each state is settled in
 * `tests/domain/terminal-presentation.test.ts`, over the whole table. What only
 * a live window can answer is the pairing, which is the whole risk of this
 * feature: the tab is drawn from a uri that carries the editor's own terminal
 * number, no API hands that number out, and what stands in for it is the ORDER
 * -- a uri asked about while exactly one terminal of ours is waiting for its
 * tab belongs to that terminal.
 *
 * So this suite asks the two questions a unit test cannot: did the workbench
 * ask us about our terminal's tab at all, and does what we answer follow the
 * record.
 *
 * What is NOT asserted, because nothing in the API can see it: that the badge
 * appears on the tab. `workbench.editor.decorations.badges` and `.colors` are
 * both `true` by default in VS Code and in Cursor (read out of both bundles,
 * 2026-08-21), and the rest is an eye check.
 */

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const TAB_TERMINAL = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const TAB_SESSION = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const NAME = 'gripterm-tab-badge';

const SETTLES_WITHIN_MS = 20_000;
const POLL_MS = 50;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function recordFor(identity: OwnerIdentity, state: PersistedTerminalState): TerminalEntry {
  const now = new Date();
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(TAB_TERMINAL),
    sessionId: SessionId.fromString(TAB_SESSION),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: NAME,
      task: null,
      notes: [],
      tags: [],
      color: null,
    }),
    launch: LaunchRecipe.create({
      cwd: os.tmpdir(),
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
      state,
      lastEventAt: now,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt: now,
  });
}

async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`waited ${String(SETTLES_WITHIN_MS)} ms for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function cleanUp(storageDir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_WRITE_DEBOUNCE_MS * 2));
  await rm(join(storageDir, 'terminals', TAB_TERMINAL), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, TAB_TERMINAL), { recursive: true, force: true });
  }
}

suite('the state of an agent on its tab', () => {
  test('pairs the tab with the record and draws the state the record is in', async () => {
    const { gateway, registry, identity, readiness, tabs } = await api();
    assert.equal(readiness.engine, 'editor', 'this suite is about the tabs the EDITOR draws');

    const entry = recordFor(identity, 'working');
    registry.register(entry);
    const handle = await gateway.create({
      // The shape the gateway keys on, not a bare string: it reads `.value`,
      // and a string has none -- which cost this suite one run and showed up as
      // a pairing logged with no terminal in it.
      terminalId: { value: TAB_TERMINAL } as unknown as Spec['terminalId'],
      name: NAME,
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      // The tab has to be drawn before the workbench asks anybody about it.
      handle.show(false);
      await until(
        'the workbench to ask about our terminal tab',
        () => tabs.uriFor(entry.terminalId) !== undefined
      );
      const uri = tabs.uriFor(entry.terminalId);
      assert.ok(uri, 'the tab was never paired with the record');
      assert.equal(uri.scheme, 'vscode-terminal', `the tab was paired with ${uri.toString()}`);

      // One argument: the provider takes the uri and nothing else, because
      // there is nothing here to cancel -- the answer is read out of a map.
      const working = tabs.provideFileDecoration(uri);
      assert.ok(working, 'nothing at all was drawn on the tab');
      assert.equal(working.badge, presentTerminal(entry).badge);
      assert.ok(String(working.tooltip).includes('working'), `the tooltip was ${String(working.tooltip)}`);

      // And it follows the record, which is the whole point: the state changes
      // for the terminal a person is NOT looking at.
      const waiting = entry.withObserved(
        ObservedState.create({
          state: 'waiting_permission',
          lastEventAt: new Date(),
          currentTool: 'Bash',
          lastAssistantMessage: null,
          cost: null,
          contextWindow: null,
          pid: null,
        })
      );
      registry.amend(waiting);

      const asked = tabs.provideFileDecoration(uri);
      assert.ok(asked);
      assert.equal(asked.badge, presentTerminal(waiting).badge);
      assert.notEqual(asked.badge, working.badge, 'the two states are drawn the same');
    } finally {
      handle.dispose();
      registry.forget(entry.terminalId);
      await cleanUp(readiness.storageDir);
    }
  });

  test('draws nothing on a tab that is not one of ours', async () => {
    const { tabs } = await api();
    const stranger = vscode.Uri.parse('vscode-terminal:/somebody-else/9999');

    assert.equal(
      tabs.provideFileDecoration(stranger),
      undefined,
      'a tab nobody paired was decorated anyway'
    );
  });
});
