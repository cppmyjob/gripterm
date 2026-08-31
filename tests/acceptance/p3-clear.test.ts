import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * П3: a person types `/clear` in their terminal. Claude Code starts a new
 * conversation with a new id; the row in the list is the SAME row, the task and
 * the notes are still on it, and the conversation it was is in its history.
 *
 * The CLI half of this was measured in M0 (A10: `ConversationEnded(reason: clear)` and
 * then `ConversationStarted(source: clear)` with a new id, on the same endpoint). What
 * is checked here is our half, on a real session -- and it is the drift of a
 * conversation under a record, which is the one thing M2.8 exists for.
 *
 * No prompt is sent: `/clear` needs no turn to happen, and a run that spends
 * money to prove something it does not test would be spending it for the look
 * of it. The price is that the conversation left behind is an empty one.
 *
 * From Ш32 the agent is `tests/acceptance/fake-claude/` unless the runner was
 * asked for a real one, so this suite normally spends nothing at all. What it
 * checks against the double is our half -- the drift of a conversation under a
 * record -- and the pair of reports it drives that half with is COPIED from A10
 * rather than invented; the head of `fake-claude.mjs` says so beside the code
 * that sends them.
 */

const SETTLES_WITHIN_MS = 90_000;
const POLL_MS = 200;

const TASK = 'the task that survives a new conversation';
const NOTE = 'the note that survives a new conversation';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stateWithin(gripterm: GriptermApi, id: string, wanted: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let seen = 'nothing at all';
  while (Date.now() < deadline) {
    seen = gripterm.registry.list().find((one) => one.terminalId.value === id)?.observed.state
      ?? 'nothing at all';
    if (seen === wanted) {
      return seen;
    }
    await sleep(POLL_MS);
  }
  return seen;
}

/** The conversation the record names now, once it is no longer the one it named before. */
async function conversationAfter(gripterm: GriptermApi, id: string, was: string): Promise<string> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  let seen = was;
  while (Date.now() < deadline) {
    seen = gripterm.registry.list().find((one) => one.terminalId.value === id)?.sessionId.value ?? was;
    if (seen !== was) {
      return seen;
    }
    await sleep(POLL_MS);
  }
  return seen;
}

interface StoredRecord {
  readonly sessionId: string;
  readonly sessionIdHistory: string[];
  readonly metadata: { readonly task: string | null, readonly notes: { readonly text: string }[] };
}

/** The record file once it says what the caller is waiting for, or the last thing it said. */
async function recordWithin(
  file: string,
  ready: (record: StoredRecord) => boolean
): Promise<StoredRecord> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  for (;;) {
    const record = JSON.parse(await readFile(file, 'utf8')) as StoredRecord;
    if (ready(record) || Date.now() > deadline) {
      return record;
    }
    await sleep(POLL_MS);
  }
}

suite('П3', () => {
  test('a new conversation under the same record, with the task and the notes still on it', async () => {
    const gripterm = await api();
    const { readiness } = gripterm;
    assert.ok(
      readiness.storageDir.includes('gripterm-acceptance'),
      `this run would write to ${readiness.storageDir}, which is not the acceptance store`
    );
    assert.equal(gripterm.registry.list().length, 0, 'the acceptance store is not empty');

    await vscode.commands.executeCommand('gripterm.newTerminal');
    const [entry] = gripterm.registry.list();
    assert.ok(entry, 'no record appeared in the registry');
    const id = entry.terminalId.value;
    const first = entry.sessionId.value;

    const trustPrompt = 15_000;
    if ((await stateWithin(gripterm, id, 'idle', trustPrompt)) !== 'idle') {
      console.log('P3: no session after 15 s, answering the CLI trust prompt with Enter');
      gripterm.gateway.handleFor(entry.terminalId)?.sendText('', true);
    }
    assert.equal(await stateWithin(gripterm, id, 'idle', SETTLES_WITHIN_MS), 'idle', 'the session never started');

    gripterm.metadata.setTask(entry.terminalId, TASK);
    gripterm.metadata.addNote(entry.terminalId, NOTE);

    await sleep(2000);
    gripterm.gateway.handleFor(entry.terminalId)?.sendText('/clear', true);

    const second = await conversationAfter(gripterm, id, first);
    console.log(`P3: ${first} -> ${second}`);
    assert.notEqual(second, first, 'the conversation never changed, so nothing was cleared');

    // One row, not two: the record is the terminal's, and the conversation under
    // it is a field (M2.8).
    assert.equal(gripterm.registry.list().length, 1, 'a second record appeared');

    const held = gripterm.registry.list()[0];
    assert.ok(held);
    assert.equal(held.terminalId.value, id, 'the record was replaced rather than updated');
    assert.equal(held.metadata.task, TASK);
    assert.deepEqual(held.metadata.notes.map((note) => note.text), [NOTE]);
    assert.deepEqual(held.sessionIdHistory.map((one) => one.value), [first]);

    // And on disk, because a restart reads the file and not the registry.
    // Polled: a change that came from an EVENT is written after a debounce of
    // half a second (M2.6), and reading once here would be a race the test wins
    // or loses by scheduling.
    const record = await recordWithin(
      join(readiness.storageDir, 'terminals', id, 'record.json'),
      (one) => one.sessionId === second
    );
    assert.equal(record.sessionId, second);
    assert.deepEqual(record.sessionIdHistory, [first]);
    assert.equal(record.metadata.task, TASK);
    assert.deepEqual(record.metadata.notes.map((note) => note.text), [NOTE]);
  });
});
