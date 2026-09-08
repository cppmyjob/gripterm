import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';
import { WatchedTerminal } from './watching-a-terminal';

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
 *
 * **WHY THIS SUITE DECIDED WHAT Ш38 REFUSES ON.** Every wait here is made
 * through `watching-a-terminal.ts`, which ends a wait early when the PROCESS
 * ends -- and never on the record's own `ended`. This file is the reason that
 * distinction had to be made rather than assumed: `/clear` takes a perfectly
 * healthy terminal through `ended` and out again (`ConversationEnded` then
 * `ConversationStarted`, the state machine's resurrection edge), and the double
 * delivers the second of that pair by spawning a `node`, so the record rests in
 * a witnessed end for longer than one poll. An instrument that read `ended` as
 * "the process is gone" would fail this suite on a terminal that is fine, most
 * runs, and would call the failure a death. What it refuses on instead --
 * `TerminalHandle.onDidClose` -- cannot happen here at all while the terminal is
 * alive, so this suite is green by construction rather than by luck.
 */

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

/** The state of the one terminal this run owns, as the registry has it right now. */
function stateOf(gripterm: GriptermApi, id: string): string {
  return gripterm.registry.list().find((one) => one.terminalId.value === id)?.observed.state
    ?? 'nothing at all';
}

/** The conversation the record names now, or `null` while it is still the one it named before. */
function conversationAfter(gripterm: GriptermApi, id: string, was: string): string | null {
  const seen = gripterm.registry.list().find((one) => one.terminalId.value === id)?.sessionId.value ?? was;
  return seen === was ? null : seen;
}

interface StoredRecord {
  readonly sessionId: string;
  readonly sessionIdHistory: string[];
  readonly metadata: { readonly task: string | null, readonly notes: { readonly text: string }[] };
}

/** The record file when it says what the caller is waiting for, and `null` until then. */
async function recordWhen(
  file: string,
  ready: (record: StoredRecord) => boolean
): Promise<StoredRecord | null> {
  const record = JSON.parse(await readFile(file, 'utf8')) as StoredRecord;
  return ready(record) ? record : null;
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
    // Before anything can end: see `watching-a-terminal.ts`.
    const watched = new WatchedTerminal(gripterm, entry.terminalId);

    // The CLI's own question about an unseen folder, answered by what is on the
    // screen rather than by a blind Enter -- see `watching-a-terminal.ts`, which
    // is where that Enter was found to be pressing `No, exit` (2026-09-08, Ш39).
    await watched.theSessionStarts(() => stateOf(gripterm, id) === 'idle');

    gripterm.metadata.setTask(entry.terminalId, TASK);
    gripterm.metadata.addNote(entry.terminalId, NOTE);

    await sleep(2000);
    gripterm.gateway.handleFor(entry.terminalId)?.sendText('/clear', true);

    // The wait that made Ш38 choose its predicate: see the head of this file.
    const second = await watched.untilThere(
      `the conversation under the record to become a different one (it was ${first}, and nothing would have been cleared if it stayed)`,
      () => conversationAfter(gripterm, id, first)
    );
    console.log(`P3: ${first} -> ${second}`);

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
    const record = await watched.untilThere(
      `the record on disk to name the new conversation (${second})`,
      async () => await recordWhen(
        join(readiness.storageDir, 'terminals', id, 'record.json'),
        (one) => one.sessionId === second
      )
    );
    assert.equal(record.sessionId, second);
    assert.deepEqual(record.sessionIdHistory, [first]);
    assert.equal(record.metadata.task, TASK);
    assert.deepEqual(record.metadata.notes.map((note) => note.text), [NOTE]);
  });
});
