import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * `/rename`, typed by a person inside a Claude Code terminal, arriving on the
 * row and on the editor's tab (M2.17).
 *
 * Run rather than described, and for the reason M2.16 paid for: the chain this
 * exercises is four seams long and every one of them belongs to somebody else --
 * the editor says which process it started, the CLI writes the new name into a
 * file named after that process, the file says whether a person chose the name,
 * and the editor renames only the terminal it considers active. 1504 unit tests
 * can pass with any of those wrong.
 *
 * No prompt is sent. `/rename` is a local command, so this costs no turn.
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

suite('rename from the CLI', () => {
  test('`/rename` inside the terminal renames the row and the tab', async () => {
    const gripterm = await api();
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
    const before = entry.metadata.displayName;

    const tab = vscode.window.terminals.find((one) => one.name === before);
    assert.ok(tab, `the editor has no terminal called ${before}`);

    const stateOf = (): string =>
      registry.list().find((one) => one.terminalId.value === id)?.observed.state ?? 'nothing at all';
    const nameOf = (): string =>
      registry.list().find((one) => one.terminalId.value === id)?.metadata.displayName ?? '';

    const trustPrompt = 15_000;
    try {
      await until('the session to start', () => stateOf() === 'idle', trustPrompt);
    } catch {
      console.log('rename: no session after 15 s, answering the CLI trust prompt with Enter');
      gripterm.gateway.handleFor(entry.terminalId)?.sendText('', true);
    }
    await until('the session to start', () => stateOf() === 'idle');

    // A person typing `/rename` is looking at that terminal, so this is the
    // state the feature lives in -- and the state the tab rename needs.
    gripterm.gateway.handleFor(entry.terminalId)?.show(true);
    await until('the terminal to be the active one', () => vscode.window.activeTerminal === tab, 15_000);

    await sleep(2000);
    gripterm.gateway.handleFor(entry.terminalId)?.sendText(`/rename ${NEW_NAME}`, true);

    await until(`the row to be called ${NEW_NAME} (it says "${nameOf()}")`, () => nameOf() === NEW_NAME);
    await until(`the tab to be called ${NEW_NAME} (it says "${tab.name}")`, () => tab.name === NEW_NAME);

    // And on disk, because a window that reloads reads the file and not the
    // registry.
    const file = join(readiness.storageDir, 'terminals', id, 'record.json');
    let stored: StoredRecord | null = null;
    const deadline = Date.now() + SETTLES_WITHIN_MS;
    while (Date.now() < deadline) {
      stored = JSON.parse(await readFile(file, 'utf8')) as StoredRecord;
      if (stored.metadata.displayName === NEW_NAME) {
        break;
      }
      await sleep(POLL_MS);
    }
    assert.equal(stored?.metadata.displayName, NEW_NAME, 'the new name never reached the store');

    console.log(`rename: "${before}" -> "${NEW_NAME}" on the row, the tab and the record`);
  });
});
