import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * П2, the first sitting: a person opens a terminal, has a conversation in it,
 * writes down what it is for, and closes the editor.
 *
 * This suite is NOT part of `test:integration`, and the separation is the point.
 * It starts a real `claude`, spends a real turn on the person's account, and
 * leaves a real conversation behind. What it does NOT touch is the person's
 * store: the runner points `gripterm.storage.directory` at a directory of its
 * own, and this suite refuses to run if that did not take effect.
 *
 * The second sitting is a separate process on purpose -- "closes the editor
 * completely" cannot be simulated inside one host -- and comes in two forms,
 * because a test host is forbidden to restore anything (`bringTerminalsBack`):
 *
 *   * `p2-second-window.test.ts`, which drives the restore explicitly, and
 *   * a development-mode editor started by the runner, where ACTIVATION does it
 *     and nobody types anything at all.
 */

const SETTLES_WITHIN_MS = 90_000;
const POLL_MS = 200;

/** Short, cheap, and with an answer that cannot be produced by accident. */
const PROMPT = 'reply with only the word pineapple';
const ANSWER = /pineapple/iu;

export const TASK = 'restore the conversation about the pineapple';
export const NOTE = 'written before the editor was closed';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** The state of the one terminal this run owns, polled because the editor moves on its own schedule. */
async function stateWithin(
  gripterm: GriptermApi,
  id: string,
  wanted: string,
  ms: number = SETTLES_WITHIN_MS
): Promise<string> {
  const deadline = Date.now() + ms;
  let seen = 'nothing at all';
  while (Date.now() < deadline) {
    seen = gripterm.registry.list().find((one) => one.terminalId.value === id)?.observed.state
      ?? 'nothing at all';
    if (seen === wanted) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return seen;
}

interface StoredRecord {
  readonly sessionId: string;
  readonly metadata: { readonly task: string | null, readonly notes: { readonly text: string }[] };
  readonly closedAt: number | null;
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
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Where the CLI said it keeps this conversation, taken from the journal this window wrote. */
function transcriptPath(storageDir: string, id: string): string | null {
  const events = join(storageDir, 'terminals', id, 'events');
  const days = existsSync(events) ? readdirSync(events) : [];
  for (const day of days) {
    for (const line of readFileSync(join(events, day), 'utf8').split(/\r?\n/u)) {
      if (line.trim().length === 0) {
        continue;
      }
      const body = (JSON.parse(line) as { body?: { transcript_path?: unknown } }).body;
      if (typeof body?.transcript_path === 'string') {
        return body.transcript_path;
      }
    }
  }
  return null;
}

/** Whether a file turns up within the wait. */
async function fileWithin(path: string): Promise<boolean> {
  const deadline = Date.now() + SETTLES_WITHIN_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

suite('П2, the first sitting', () => {
  test('opens a terminal, holds a conversation, and writes the task and the note down', async () => {
    const gripterm = await api();
    const { readiness } = gripterm;

    // The guard that makes the rest of this safe to run at all.
    assert.ok(
      readiness.storageDir.includes('gripterm-acceptance'),
      `this run would write to ${readiness.storageDir}, which is not the acceptance store`
    );
    assert.equal(readiness.sharing, true, 'this window is not reading the store');
    assert.equal(readiness.refusal, null, `the launch pipeline refused: ${String(readiness.refusal)}`);
    assert.equal(gripterm.registry.list().length, 0, 'the acceptance store is not empty');

    // П1's own first half, and the only way a record is ever born.
    await vscode.commands.executeCommand('gripterm.newTerminal');

    const [entry] = gripterm.registry.list();
    assert.ok(entry, 'no record appeared in the registry');
    const id = entry.terminalId.value;

    // `ConversationStarted`, arriving over a real hook from a real CLI -- unless the
    // CLI is asking its own question first. A folder Claude Code has not seen
    // before gets a trust prompt, and until it is answered no session starts and
    // no hook fires (measured 2026-08-13; the same wall A13 met in a temporary
    // profile). The stand answers it with Enter, the way a person would and the
    // way the A19 stand did, and says so rather than sending a key blindly.
    const trustPrompt = 15_000;
    if ((await stateWithin(gripterm, id, 'idle', trustPrompt)) !== 'idle') {
      console.log('P2 phase 1: no session after 15 s, answering the CLI trust prompt with Enter');
      gripterm.gateway.handleFor(entry.terminalId)?.sendText('', true);
    }
    assert.equal(await stateWithin(gripterm, id, 'idle'), 'idle', 'the session never started');

    // The turn. Sent into the terminal the way a person types it, which is also
    // the first time this project has done that outside a stand (A13).
    const handle = gripterm.gateway.handleFor(entry.terminalId);
    assert.ok(handle, 'the gateway does not hold the terminal it just created');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    handle.sendText(PROMPT, true);

    assert.equal(await stateWithin(gripterm, id, 'working'), 'working', 'the prompt never landed');
    assert.equal(await stateWithin(gripterm, id, 'idle'), 'idle', 'the turn never finished');

    const answered = gripterm.registry.list().find((one) => one.terminalId.value === id);
    assert.ok(answered);
    assert.match(answered.observed.lastAssistantMessage ?? '', ANSWER);

    // What П2 asks to survive the restart, written through the same service the
    // two dialogs stand in front of.
    gripterm.metadata.setTask(entry.terminalId, TASK);
    gripterm.metadata.addNote(entry.terminalId, NOTE);

    // And on disk, because that is the only thing the next editor will read.
    // Polled rather than read once: the writer of M2.6 puts a change the window
    // itself made on the next tick rather than in the same one, and a single
    // read here would be a race the test wins or loses by scheduling.
    const file = join(readiness.storageDir, 'terminals', id, 'record.json');
    const wroteAt = Date.now();
    const record = await recordWithin(file, (one) => one.metadata.task === TASK);
    console.log(`P2 phase 1: the task reached the disk in ${Date.now() - wroteAt} ms`);
    assert.equal(record.metadata.task, TASK);
    assert.deepEqual(record.metadata.notes.map((note) => note.text), [NOTE]);
    assert.equal(record.closedAt, null, 'the record says the terminal was closed');

    // The conversation has to be resumable, and that means a transcript on disk:
    // `--resume` on a conversation without one exits 1 (measured 2026-08-10),
    // and the restore predicate refuses such a record outright (M2.10). The CLI
    // names the path in every hook body; whether the FILE is there yet is a
    // different question, and the first acceptance run answered it the hard way
    // -- the editor closed a second after the turn, and nothing was ever
    // written. So this waits for it, and says how long it took.
    const transcript = transcriptPath(readiness.storageDir, id);
    assert.ok(transcript !== null, 'no hook ever said where the transcript would be');
    const waitedFrom = Date.now();
    const appeared = await fileWithin(transcript);
    console.log(
      appeared
        ? `P2 phase 1: the transcript appeared ${Date.now() - waitedFrom} ms after the turn`
        : `P2 phase 1: NO transcript at ${transcript}`
    );
    assert.ok(appeared, 'the conversation has no transcript, so nothing could bring it back');

    console.log(`P2 phase 1: terminal ${id}, conversation ${record.sessionId}`);
    console.log(`P2 phase 1: answer ${JSON.stringify(answered.observed.lastAssistantMessage)}`);
  });
});
