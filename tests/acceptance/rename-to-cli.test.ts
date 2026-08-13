import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeSessionsDirectory } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The other direction (M2.19): a name given HERE reaching Claude Code itself.
 *
 * Run rather than described, and for a reason this file is the only place to
 * check: there is no channel for it but the one a person has. The name is TYPED
 * into the terminal as `/rename`, and whether that arrives depends on a real
 * CLI, a real prompt box and a real pty -- none of which a unit test has.
 *
 * Two halves, and the first one costs nothing to check on the way past: a
 * terminal is started with `--name`, so the CLI's own view of the conversation
 * carries the row's name before anybody renames anything.
 *
 * No prompt is sent. `/rename` is a local command, so this costs no turn.
 */

const SETTLES_WITHIN_MS = 90_000;
const POLL_MS = 250;

const NEW_NAME = 'gripterm-told-the-cli';

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

/** What the CLI calls the conversation held by `pid`, out of its own file. */
async function nameInTheCli(pid: number): Promise<string | null> {
  const file = join(
    claudeSessionsDirectory({
      platform: process.platform,
      home: homedir(),
      configDir: process.env.CLAUDE_CONFIG_DIR,
    }),
    `${pid.toString()}.json`
  );
  try {
    const payload: unknown = JSON.parse(await readFile(file, 'utf8'));
    const name = (payload as { readonly name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

suite('rename to the CLI', () => {
  test('a name given here reaches the conversation itself', async () => {
    const gripterm = await api();
    const { readiness, registry, metadata } = gripterm;
    assert.ok(
      readiness.storageDir.includes('gripterm-acceptance'),
      `this run would write to ${readiness.storageDir}, which is not the acceptance store`
    );
    assert.equal(registry.list().length, 0, 'the acceptance store is not empty');

    await vscode.commands.executeCommand('gripterm.newTerminal');
    const [entry] = registry.list();
    assert.ok(entry, 'no record appeared in the registry');
    const id = entry.terminalId.value;
    const started = entry.metadata.displayName;

    const stateOf = (): string =>
      registry.list().find((one) => one.terminalId.value === id)?.observed.state ?? 'nothing at all';
    const pidOf = (): number | null =>
      registry.list().find((one) => one.terminalId.value === id)?.observed.pid ?? null;

    const trustPrompt = 15_000;
    try {
      await until('the session to start', () => stateOf() === 'idle', trustPrompt);
    } catch {
      console.log('rename: no session after 15 s, answering the CLI trust prompt with Enter');
      gripterm.gateway.handleFor(entry.terminalId)?.sendText('', true);
    }
    await until('the session to start', () => stateOf() === 'idle');

    const pid = pidOf();
    assert.ok(pid !== null, 'the record has no pid, so the CLI cannot be asked anything');

    // The first half, and it needed nobody to do anything: `--name` at launch.
    let atStart: string | null = null;
    const deadline = Date.now() + SETTLES_WITHIN_MS;
    while (Date.now() < deadline && atStart !== started) {
      atStart = await nameInTheCli(pid);
      if (atStart === started) {
        break;
      }
      await sleep(POLL_MS);
    }
    assert.equal(atStart, started, 'the CLI was never told the name the terminal started with');

    // The second half: renamed here, and the conversation is told by typing.
    await sleep(2000);
    metadata.rename(entry.terminalId, NEW_NAME);

    let after: string | null = null;
    const untilRenamed = Date.now() + SETTLES_WITHIN_MS;
    while (Date.now() < untilRenamed) {
      after = await nameInTheCli(pid);
      if (after === NEW_NAME) {
        break;
      }
      await sleep(POLL_MS);
    }
    assert.equal(after, NEW_NAME, 'the conversation never took the name given here');

    console.log(`rename: "${started}" -> "${NEW_NAME}" reached Claude Code's own session file`);
  });
});
