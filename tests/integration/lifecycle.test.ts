import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import { request as httpRequest } from 'node:http';
import { statSync } from 'node:fs';
import { CONTEXT_LIVE, CONTEXT_OVER } from '../../packages/core/src/index';
import type { GriptermApi } from '../../packages/extension/src/extension';

const TERMINAL_UUID = '550e8400-e29b-41d4-a716-446655440000';

/** A POST to our own receiver, with no token: the shape any process on this machine can send. */
async function post(url: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const sent = httpRequest(url, { method: 'POST' }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end('{}');
  });
}

interface MenuItem {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function menuItems(): readonly MenuItem[] {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension);
  const manifest = extension.packageJSON as {
    contributes: { menus: Record<string, MenuItem[]> };
  };
  return manifest.contributes.menus['view/item/context'] ?? [];
}

suite('the lifecycle commands', () => {
  test('are registered, so the manifest is not promising buttons that do nothing', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('gripterm.newTerminal'), 'newTerminal is not registered');
    assert.ok(commands.includes('gripterm.closeTerminal'), 'closeTerminal is not registered');
  });

  test('key their row menus on the context values the presenter actually produces', async () => {
    // A `when` clause naming a `viewItem` the presenter never sets is a menu
    // entry that simply never appears -- silent everywhere else, because nothing
    // fails and nothing is logged. This is the only place the two spellings meet.
    await api();
    const items = menuItems();
    assert.ok(items.length > 0, 'the view contributes no row menu at all');

    const named = items.map((item) => /viewItem == ([\w.]+)/u.exec(item.when)?.[1]);
    assert.ok(
      named.every((value) => value !== undefined),
      'a row menu is shown for every row, whatever its state'
    );
    assert.deepEqual([...new Set(named)].sort(), [CONTEXT_LIVE, CONTEXT_OVER].sort());
  });

  test('do nothing dramatic when there is no terminal to close', async () => {
    // The palette path with an empty list. It says so and returns; a command
    // that waited on the notification it just raised would never return at all.
    await api();

    await vscode.commands.executeCommand('gripterm.closeTerminal');
  });
});

suite('the launch pipeline', () => {
  /**
   * The successor of the test that guarded workaround C4.
   *
   * Until M1.14 this suite asserted a REFUSAL naming the milestone, so that
   * composing the pipeline would turn it red rather than leave a placeholder to
   * be found years later. It is now the other half of that promise: the same
   * situation, asserted from the other side.
   */
  test('is composed, so nothing refuses by construction any more', async () => {
    const { readiness } = await api();

    assert.equal(readiness.refusal, null, readiness.refusal ?? '');
    assert.ok(readiness.address, 'no hook receiver is listening');
    assert.notEqual(readiness.cliPath, null, 'claude was not found');
  });

  test('found the Claude Code this machine will actually run', async () => {
    // Machine-dependent ON PURPOSE. A machine without `claude` cannot run the
    // acceptance of M1.15 either, so a red line here is a true statement about
    // where the suite is running -- not a test that should have adapted.
    const { readiness } = await api();

    const { cliPath } = readiness;
    assert.notEqual(cliPath, null, 'claude was not found on PATH');
    assert.ok(isAbsolute(cliPath ?? ''), `${cliPath ?? ''} is not an absolute path`);
    // The version is read by running the binary, never by reading the update
    // journal -- which reported an upgrade twice while the binary stayed the
    // same. A null here means `claude --version` did not answer at all.
    assert.notEqual(readiness.cliVersion, null, 'claude did not say which version it is');
  });

  test('ships the hook forwarder inside the installation', async () => {
    // The one failure this catches is ours: a packaging change that drops
    // `assets/`. It would cost every terminal its `SessionStart` -- silently,
    // because a failed hook is non-blocking.
    const { readiness } = await api();

    assert.ok(readiness.forwarder, 'no forwarder was composed (is node on PATH?)');
    assert.ok(isAbsolute(readiness.forwarder.scriptPath));
    assert.ok(isAbsolute(readiness.forwarder.interpreterPath));
    assert.ok(statSync(readiness.forwarder.scriptPath).isFile(), 'the forwarder script is missing');
  });

  test('answers on the port it wrote into every settings file', async () => {
    // The receiver, reached the way the CLI reaches it: over a socket, from
    // outside. Nothing else in the suite proves the port is open rather than
    // merely allocated.
    const { readiness } = await api();
    assert.ok(readiness.address);

    const answered = await post(`${readiness.address.origin}/ev/${TERMINAL_UUID}`);

    // 401 and not 404: an unauthenticated caller is turned away BEFORE the
    // terminal is looked up, and before a body is read (§4.7). Any process on
    // this machine can reach a loopback port.
    assert.equal(answered, 401);
  });
});
