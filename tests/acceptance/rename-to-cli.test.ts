import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeSessionsDirectory } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';
import { WatchedTerminal } from './watching-a-terminal';

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
 *
 * From Ш32 the conversation is normally held by `tests/acceptance/fake-claude/`,
 * and the session file this reads is one the double wrote. That the file is
 * NAMED after the pid, carries `name`, and marks a name a person chose with
 * `nameSource: "user"`, are all measurements of the real CLI (M2.19 2026-08-13,
 * and 2026-09-08 against 2.1.260) that the double copies rather than invents.
 * The mark moved between those two dates -- 2.1.228 REMOVED the key on `/rename`,
 * 2.1.260 writes `user` into it -- and `readSessionName` accepts either; this
 * suite reads only `name` and so says nothing about which. And
 * `CLAUDE_CONFIG_DIR`, which is what puts the double's file where this looks for
 * the CLI's, is moved into the run's own directory by the runner so that neither
 * side goes near a person's profile.
 */

const NEW_NAME = 'gripterm-told-the-cli';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    // Before anything can end: see `watching-a-terminal.ts`.
    const watched = new WatchedTerminal(gripterm, entry.terminalId);

    const stateOf = (): string =>
      registry.list().find((one) => one.terminalId.value === id)?.observed.state ?? 'nothing at all';
    const pidOf = (): number | null =>
      registry.list().find((one) => one.terminalId.value === id)?.observed.pid ?? null;

    // The CLI's own question about an unseen folder, answered by what is on the
    // screen -- see `rename-from-cli.test.ts` and `watching-a-terminal.ts`, where
    // the blind Enter this replaced was found to be pressing `No, exit`.
    await watched.theSessionStarts(() => stateOf() === 'idle');

    const pid = pidOf();
    assert.ok(pid !== null, 'the record has no pid, so the CLI cannot be asked anything');

    // The first half, and it needed nobody to do anything: `--name` at launch.
    // The wait comes back with the name or says why it never will, so there is
    // nothing left here for an assertion to add.
    await watched.untilThere(
      `the CLI to be told the name the terminal started with ("${started}")`,
      async () => ((await nameInTheCli(pid)) === started ? started : null)
    );

    // The second half: renamed here, and the conversation is told by typing.
    await sleep(2000);
    metadata.rename(entry.terminalId, NEW_NAME);

    await watched.untilThere(
      `the conversation itself to take the name given here ("${NEW_NAME}")`,
      async () => ((await nameInTheCli(pid)) === NEW_NAME ? NEW_NAME : null)
    );

    console.log(`rename: "${started}" -> "${NEW_NAME}" reached Claude Code's own session file`);
  });
});
