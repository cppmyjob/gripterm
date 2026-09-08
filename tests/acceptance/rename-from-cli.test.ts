import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TerminalEntry } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * `/rename`, typed by a person inside a Claude Code terminal, arriving on the
 * row, in the record and on the editor's tab (M2.17).
 *
 * Run rather than described, and for the reason M2.16 paid for: the chain this
 * exercises is four seams long and every one of them belongs to somebody else --
 * the editor says which process it started, the CLI writes the new name into a
 * file named after that process, the file says whether a person chose the name,
 * and the editor renames only the terminal it considers active. 1504 unit tests
 * can pass with any of those wrong.
 *
 * No prompt is sent. `/rename` is a local command, so this costs no turn.
 *
 * **TWO SUITES SINCE 2026-09-08 (Ш37), because the halves have different
 * subjects.** Until that day this was ONE suite called `rename from the CLI`,
 * and `tests/acceptance/run.mjs` excluded the whole of it under our own engine.
 * That exclusion was FOUND BY RUNNING IT (2026-08-31, the first time this
 * acceptance was walked under `own` at all): the suite's third line asks
 * `vscode.window.terminals` for a terminal object, and a terminal our own engine
 * makes is not one -- it failed with "the editor has no terminal called
 * project", which is the suite being right rather than the engine being wrong.
 * What that cost was written down at the time, and it is what this split pays
 * back: the half of M2.17 which is not the editor's at all -- `/rename` typed
 * inside the terminal reaching the ROW and the RECORD -- was walked under `own`
 * by nothing.
 *
 *   * `rename from the CLI reaches the row` is that half. It asks the registry,
 *     the list's own provider and the store, none of which is the editor's, so
 *     it runs under BOTH engines.
 *   * `rename from the CLI reaches an editor tab` is the other half, unchanged
 *     in what it does. It stays excluded under `own` by name, with the reason in
 *     `NOT_UNDER_OWN`.
 *
 * **WHAT THE SPLIT MEASURED, THE SAME DAY, AND AGAINST WHOM.** The
 * engine-neutral half was walked under `own` for the first time on 2026-09-08
 * and it is GREEN -- 31 s for the whole `rename` criterion, the new name on the
 * row, in the record and on our own tab -- AGAINST THE DOUBLE IN
 * `tests/acceptance/fake-claude/` and not against Claude Code. Under `editor`,
 * green in 38 s, with this window's strip holding 0 tabs, which is the reading
 * two paragraphs below confirmed by a run rather than by argument. The head of
 * `fake-claude.mjs` is what bounds both of those greens: it lists, one by one,
 * what the double does not do.
 *
 * **AND AGAINST THE REAL `claude` THE SAME CRITERION IS RED, ON BOTH ENGINES,
 * AND THE CAUSE IS NOT ESTABLISHED.** Measured 2026-09-08 with
 * `GRIPTERM_ACCEPTANCE_AGENT=real` against CLI 2.1.260, the first time this
 * acceptance had ever been walked against the real thing: under `own`, twice out
 * of two, no session inside 90 s; under `editor`, once, the session started but
 * the row never took the new name. WHICH SIDE IS BROKEN IS NOT KNOWN and is not
 * guessed at here -- the candidates are this stand in its `real` mode, which
 * nothing had run until that day, and the product; the owner works under `own`
 * with a real `claude` daily and his terminals come up, which weighs against the
 * second without settling the first. `tools/gate.mjs` carries the finding whole.
 *
 * **A GREEN FROM THIS FILE THEREFORE MEANS: the double, not Claude Code.**
 *
 * **WHAT THE ENGINE-NEUTRAL HALF CAN REACH, established by reading on
 * 2026-09-08 rather than assumed.** `GriptermApi` hands out the registry, the
 * store's directory, the list's data provider and this window's own strip of
 * tabs -- and not the editor's terminal objects, which under `own` do not exist.
 *
 *   * THE ROW is read through `GriptermApi.tree`, the provider the contributed
 *     list itself draws from, so the assertion is on the label the platform is
 *     handed (`presentTerminal`) and not on the record read a second time.
 *   * THE RECORD is `record.json` in the acceptance store, because a window that
 *     reloads reads the file and not the registry.
 *   * OUR OWN TAB -- `GriptermApi.strip.tabs`, the strip as this window last
 *     drew it -- is reachable UNDER `own` ONLY, and that is a fact about the
 *     panel rather than a convenience: the stage takes a terminal when the
 *     gateway calls `opened` with a handle that HAS a screen, and only
 *     `PtyTerminalGateway` makes those. Under the editor's engine this window's
 *     strip holds nothing, so there is no tab of ours to be right or wrong
 *     about. It is asserted where it exists and said out loud where it does not.
 */

const SETTLES_WITHIN_MS = 90_000;
const POLL_MS = 200;

const NEW_NAME = 'gripterm-acceptance-renamed';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, ready: () => boolean, ms = SETTLES_WITHIN_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    }
    await sleep(POLL_MS);
  }
}

interface StoredRecord {
  readonly metadata: { readonly displayName: string };
}

/**
 * One terminal of this window's own, with a conversation running in it.
 *
 * Shared by both halves rather than written twice: they run in separate hosts,
 * on separate stores, so the code is the only thing they can share -- and two
 * copies of the trust-prompt answer would be two places to correct the day the
 * CLI asks something else.
 */
async function aTerminalWithASession(gripterm: GriptermApi): Promise<TerminalEntry> {
  const { readiness, registry } = gripterm;
  assert.ok(
    readiness.storageDir.includes('gripterm-acceptance'),
    `this run would write to ${readiness.storageDir}, which is not the acceptance store`
  );
  assert.equal(registry.list().length, 0, 'the acceptance store is not empty');

  await vscode.commands.executeCommand('gripterm.newTerminal');
  const [entry] = registry.list();
  assert.ok(entry, 'no record appeared in the registry');
  const id = entry.terminalId.value;

  const stateOf = (): string =>
    registry.list().find((one) => one.terminalId.value === id)?.observed.state ?? 'nothing at all';

  /*
   * A BLIND ENTER, AND THE LINE IT PRINTS USED TO CLAIM MORE THAN THAT.
   *
   * The real CLI puts a trust prompt in front of a folder it has not seen
   * (measured 2026-08-13, quoted in `p2-first-window.test.ts`), and this is the
   * Enter for it. What this code can see is only that no session started inside
   * 15 s: it reads the record's state and nothing else, so it never sees a
   * prompt, and until 2026-09-08 it printed "answering the CLI trust prompt with
   * Enter" as though it had. THAT WAS A GUESS OF THE INSTRUMENT, and the run
   * that showed it up is in `tools/gate.mjs`: against the real CLI under `own`
   * the line printed in both runs and the session still never came, so what it
   * announced as an answer was the timeout and not a prompt. The double asks
   * nothing before it starts, by its own head, so under `fake` this branch is
   * never reached at all.
   */
  const trustPrompt = 15_000;
  try {
    await until('the session to start', () => stateOf() === 'idle', trustPrompt);
  } catch {
    console.log('rename: no session after 15 s; sending a blind Enter, in case the CLI is waiting to be trusted -- nothing here has seen a prompt');
    gripterm.gateway.handleFor(entry.terminalId)?.sendText('', true);
  }
  await until('the session to start', () => stateOf() === 'idle');
  return entry;
}

/**
 * What the LIST is drawing on that row, out of the provider it draws from.
 *
 * `null` when no row of that id is there at all, which is a different failure
 * from a row still wearing the old name and is reported as one.
 */
function rowLabel(gripterm: GriptermApi, terminalId: string): string | null {
  const { tree } = gripterm;
  for (const heading of tree.getChildren()) {
    for (const node of tree.getChildren(heading)) {
      const item = tree.getTreeItem(node);
      if (item.id !== terminalId) {
        continue;
      }
      const { label } = item;
      return typeof label === 'string' ? label : label?.label ?? null;
    }
  }
  return null;
}

/** What OUR strip has on that tab, or `null` when this window's panel holds no such tab. */
function tabLabel(gripterm: GriptermApi, terminalId: string): string | null {
  return gripterm.strip.tabs.find((tab) => tab.terminalId === terminalId)?.label ?? null;
}

/**
 * What the store says the terminal is called, or `null` while it says nothing
 * readable.
 *
 * A half-written file is a `null` here and not a throw: the record is written
 * whole and renamed into place, so a read that lands on the moment between is a
 * moment of the poll rather than a fault.
 */
async function storedName(storageDir: string, terminalId: string): Promise<string | null> {
  const file = join(storageDir, 'terminals', terminalId, 'record.json');
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredRecord;
    return stored.metadata.displayName;
  } catch {
    return null;
  }
}

suite('rename from the CLI reaches the row', () => {
  test('typed inside the terminal, the new name is on the row, in the record and on our own tab', async () => {
    const gripterm = await api();
    const { readiness, registry } = gripterm;
    const entry = await aTerminalWithASession(gripterm);
    const id = entry.terminalId.value;
    const before = entry.metadata.displayName;

    const nameOf = (): string =>
      registry.list().find((one) => one.terminalId.value === id)?.metadata.displayName ?? '';

    await sleep(2000);
    gripterm.gateway.handleFor(entry.terminalId)?.sendText(`/rename ${NEW_NAME}`, true);

    // The ROW, through the provider the list itself draws from. The registry is
    // read for the message and not for the assertion: a record read twice would
    // show only that this file can read a field.
    await until(
      `the row to be called ${NEW_NAME} (the list said "${rowLabel(gripterm, id) ?? 'nothing'}" and the record "${nameOf()}" when the wait began)`,
      () => rowLabel(gripterm, id) === NEW_NAME
    );

    // And on disk, because a window that reloads reads the file and not the
    // registry.
    let stored: string | null = null;
    const deadline = Date.now() + SETTLES_WITHIN_MS;
    while (Date.now() < deadline) {
      stored = await storedName(readiness.storageDir, id);
      if (stored === NEW_NAME) {
        break;
      }
      await sleep(POLL_MS);
    }
    assert.equal(stored, NEW_NAME, 'the new name never reached the store');

    // Our own tab, where there is one. See the head of this file: the panel
    // holds a terminal only when its handle has a screen, which is our own
    // engine's and not the editor's.
    if (readiness.engine === 'own') {
      await until(
        `our own tab to be called ${NEW_NAME} (it said "${tabLabel(gripterm, id) ?? 'nothing'}" when the wait began)`,
        () => tabLabel(gripterm, id) === NEW_NAME
      );
      console.log(`rename: "${before}" -> "${NEW_NAME}" on the row, in the record and on our own tab`);
      return;
    }
    console.log(
      `rename: "${before}" -> "${NEW_NAME}" on the row and in the record; under the editor's engine this window's `
      + `strip holds ${gripterm.strip.tabs.length.toString()} tabs, so there is none of ours to read`
    );
  });
});

suite('rename from the CLI reaches an editor tab', () => {
  test('typed inside the terminal, the new name is on the tab the editor drew', async () => {
    const gripterm = await api();
    const entry = await aTerminalWithASession(gripterm);
    const before = entry.metadata.displayName;

    const tab = vscode.window.terminals.find((one) => one.name === before);
    assert.ok(tab, `the editor has no terminal called ${before}`);

    // A person typing `/rename` is looking at that terminal, so this is the
    // state the feature lives in -- and the state the tab rename needs.
    gripterm.gateway.handleFor(entry.terminalId)?.show(true);
    await until('the terminal to be the active one', () => vscode.window.activeTerminal === tab, 15_000);

    await sleep(2000);
    gripterm.gateway.handleFor(entry.terminalId)?.sendText(`/rename ${NEW_NAME}`, true);

    await until(
      `the tab to be called ${NEW_NAME} (it said "${tab.name}" when the wait began)`,
      () => tab.name === NEW_NAME
    );

    console.log(`rename: "${before}" -> "${NEW_NAME}" on the tab the editor draws`);
  });
});
