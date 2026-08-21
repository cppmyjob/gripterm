import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  HumanMetadata,
  LaunchRecipe,
  ObservedState,
  SessionId,
  TerminalEntry,
  TerminalId,
  ownerRefFor,
  type OwnerIdentity,
} from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The order the tabs stand in, and a person dragging one of them.
 *
 * **What the owner reported on 2026-08-21**, after the acceptance run: "после
 * перезагрузки меняется порядок табов терминалов... сначала идёт таб с
 * терминалом 2 а потом 1", and -- the half that made it worse -- "табы нельзя
 * поменять местами - нет drag and drop". An order that changes by itself is
 * annoying; an order that changes by itself and cannot be corrected is a person
 * watching their own window rearrange itself.
 *
 * **Why this is a live test and not a unit one.** Every piece of the rule is
 * checked in jest already -- where a tab lands (`drop-rule`), what the record
 * then says (`terminal-order`), what the strip draws (`terminal-strip`). What
 * none of them can check is the CHAIN: a real drag on a real element in a real
 * webview, over the channel, into a record, and back out as a redrawn strip.
 * Every one of those seams is one this build has been wrong about before.
 */

const FIRST_TERMINAL = '550e8400-e29b-41d4-a716-446655442001';
const SECOND_TERMINAL = '550e8400-e29b-41d4-a716-446655442002';
const FIRST_SESSION = '550e8400-e29b-41d4-a716-446655442101';
const SECOND_SESSION = '550e8400-e29b-41d4-a716-446655442102';

const SETTLES_WITHIN_MS = 30_000;
const LOOK_EVERY_MS = 25;
const MINUTE_MS = 60_000;

type Gateway = ReturnType<GriptermApi['makeGateway']>;
type Handle = Awaited<ReturnType<Gateway['create']>>;
type Spec = Parameters<Gateway['create']>[0];

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function extensionPath(): string {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return extension.extensionPath;
}

/** A process that stays up until its terminal is disposed. Nothing is typed into it. */
function lingering(): { readonly path: string, readonly args: readonly string[] } {
  const comSpec = process.env.ComSpec ?? join('C:', 'Windows', 'System32', 'cmd.exe');
  return process.platform === 'win32'
    ? { path: comSpec, args: ['/c', 'pause'] }
    : { path: '/bin/sh', args: ['-c', 'read line'] };
}

/**
 * A record of this window's own, made at a named moment.
 *
 * The moment is the whole fixture: with no arrangement on either record, the
 * moment of creation is what decides the order -- which is the rule the drag is
 * about to overrule.
 */
function recordFor(
  identity: OwnerIdentity,
  terminalId: string,
  sessionId: string,
  name: string,
  createdAt: Date
): TerminalEntry {
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(terminalId),
    sessionId: SessionId.fromString(sessionId),
    owner: ownerRefFor(identity),
    metadata: HumanMetadata.create({
      displayName: name,
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
      state: 'idle',
      lastEventAt: createdAt,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
    createdAt,
  });
}

async function until<T>(what: string, answer: () => T | null): Promise<T> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  while (Date.now() < deadline) {
    const found = answer();
    if (found !== null) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/**
 * This suite's own two tabs, in the order the STRIP has them.
 *
 * Filtered rather than counted, and that is a measured lesson: in the gate every
 * suite runs in one window, and the tabs other suites ended keep their place
 * until somebody closes them (M3.9). A test that waited for a strip of exactly
 * two would pass when run alone and fail in the run that matters -- which is
 * what it did, once, before this line.
 */
function drawn(gripterm: GriptermApi): readonly string[] {
  return gripterm.strip.tabs
    .map((tab) => tab.terminalId)
    .filter((terminalId) => terminalId === FIRST_TERMINAL || terminalId === SECOND_TERMINAL);
}

/** Everything these two records leave in the person's store. */
async function forgetOnDisk(): Promise<void> {
  const { readiness } = await api();
  for (const terminalId of [FIRST_TERMINAL, SECOND_TERMINAL]) {
    await rm(join(readiness.storageDir, 'terminals', terminalId), {
      recursive: true,
      force: true,
    }).catch(() => null);
  }
}

suite('the order of the tabs, and a hand that changes it', () => {
  let gateway: Gateway | null = null;
  let handles: Handle[] = [];

  suiteSetup(async () => {
    const { makeGateway, stage, registry, identity, workbench } = await api();
    await forgetOnDisk();

    // Two records, made a minute apart, so the order they start in is the one
    // the person watched them appear in rather than an accident of the fixture.
    const madeAt = Date.now() - 2 * MINUTE_MS;
    registry.register(
      recordFor(identity, FIRST_TERMINAL, FIRST_SESSION, 'gripterm-order-one', new Date(madeAt))
    );
    registry.register(
      recordFor(
        identity,
        SECOND_TERMINAL,
        SECOND_SESSION,
        'gripterm-order-two',
        new Date(madeAt + MINUTE_MS)
      )
    );

    gateway = makeGateway({
      setting: 'own',
      mode: 'process',
      // `panel`, not the default group: a gateway of this suite must not move
      // the editor layout the other suites are looking at.
      location: 'panel',
      extensionPath: extensionPath(),
      editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
      ideChannel: false,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      audience: stage,
    });
    const process0 = lingering();
    for (const [terminalId, name] of [
      [FIRST_TERMINAL, 'gripterm-order-one'],
      [SECOND_TERMINAL, 'gripterm-order-two'],
    ] as const) {
      handles.push(
        await gateway.create({
          terminalId: { value: terminalId } as unknown as Spec['terminalId'],
          name,
          cwd: os.tmpdir(),
          env: {},
          shellPath: process0.path,
          shellArgs: [...process0.args],
        })
      );
    }

    await vscode.commands.executeCommand('gripterm.workbench.focus');
    await workbench.whenReady(SETTLES_WITHIN_MS);
  });

  suiteTeardown(async () => {
    const { stage, registry } = await api();
    // The gateway ends them, once. Disposing the handles here as well is the
    // double kill that crashed a live run on 2026-08-21 -- guarded in the
    // adapter now, and deliberately exercised in `terminal-gateway-contract`
    // rather than left in every teardown that happens to do it.
    handles = [];
    for (const terminalId of [FIRST_TERMINAL, SECOND_TERMINAL]) {
      // Taken off the strip by this suite, or the tabs live for the rest of the
      // run and turn up in somebody else's counts (M3.9).
      stage.removed(terminalId);
      registry.forget(TerminalId.fromString(terminalId));
    }
    gateway?.dispose();
    gateway = null;
    await forgetOnDisk();
  });

  test('stands them in the order they were made, before anybody has arranged them', async () => {
    const gripterm = await api();

    const order = await until('both tabs to be drawn', () => {
      const tabs = drawn(gripterm);
      return tabs.length === 2 ? tabs : null;
    });

    assert.deepEqual(
      [...order],
      [FIRST_TERMINAL, SECOND_TERMINAL],
      'the strip is not in the order the terminals were made'
    );
  });

  test('moves the tab a person drags, and writes it into the record', async () => {
    const gripterm = await api();
    await until('both tabs to be drawn', () => (drawn(gripterm).length === 2 ? true : null));

    // The second tab, picked up and let go on the LEFT half of the first: the
    // gesture a person makes to put it in front.
    gripterm.workbench.dragTab(SECOND_TERMINAL, FIRST_TERMINAL, false);

    const moved = await until('the strip to follow the hand', () => {
      const tabs = drawn(gripterm);
      return tabs[0] === SECOND_TERMINAL ? tabs : null;
    });
    assert.deepEqual([...moved], [SECOND_TERMINAL, FIRST_TERMINAL]);

    // And it is in the RECORD, which is the half that survives a restart -- the
    // whole complaint was an order that came back different.
    const record = gripterm.registry.get(TerminalId.fromString(SECOND_TERMINAL));
    const other = gripterm.registry.get(TerminalId.fromString(FIRST_TERMINAL));
    assert.ok(record, 'the record of the dragged terminal is gone');
    assert.ok(other, 'the record of the other terminal is gone');
    assert.notEqual(record.order, null, 'the tab moved and nothing was written down');
    assert.ok(
      record.placement < other.placement,
      `the record still says the dragged terminal is behind: ${String(record.placement)} vs ${String(other.placement)}`
    );
  });
});
