import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  CONTEXT_ABANDONED,
  CONTEXT_ADOPTABLE,
  CONTEXT_FOREIGN,
  CONTEXT_LIVE,
  CONTEXT_OVER,
} from '../../packages/core/src/index';
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

function titleItems(): readonly MenuItem[] {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension);
  const manifest = extension.packageJSON as {
    contributes: { menus: Record<string, MenuItem[]> };
  };
  return manifest.contributes.menus['view/title'] ?? [];
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
    assert.deepEqual(
      [...new Set(named)].sort(),
      [CONTEXT_LIVE, CONTEXT_OVER, CONTEXT_ADOPTABLE, CONTEXT_ABANDONED].sort()
    );
  });

  /*
   * M2.22, and the rule this suite exists to hold: EVERY value a row can be
   * drawn with offers something, except the one value that means "another window
   * is answering for this". A row that offers nothing else is a row a person
   * cannot get rid of -- which is what the owner met on 2026-08-13, on a record
   * left behind by a window that had closed.
   *
   * Written as "deletion is offered on all but one" rather than as a list,
   * because a list is a copy of the manifest and would be updated alongside it
   * by whoever broke this.
   */
  test('leaves no row a person cannot get rid of', async () => {
    await api();
    const rows = new Set(
      menuItems()
        .filter((item) => item.command === 'gripterm.deleteTerminal')
        .map((item) => /viewItem == ([\w.]+)/u.exec(item.when)?.[1] ?? '')
    );

    for (const value of [CONTEXT_OVER, CONTEXT_ADOPTABLE, CONTEXT_ABANDONED]) {
      assert.ok(rows.has(value), `a ${value} row has no way to be deleted`);
    }
    // Its window is there and is the single writer of that record (§4.8).
    assert.equal(rows.has(CONTEXT_FOREIGN), false);
  });

  /*
   * M2.7 added five edit commands offered on both kinds of row, and one
   * deletion offered on neither kind but the finished one. Written out as a
   * table rather than left to the reading above, because the failure it guards
   * is silent in both directions: a `when` clause that never matches is a menu
   * entry nobody ever sees, and one that matches too much offers deletion of a
   * terminal that is still running.
   *
   * `=~` was used here first, with the two row values in one regular
   * expression. It was replaced by the plain `==` this manifest already proves,
   * because nothing available to this suite evaluates a `when` clause -- so a
   * mistake in the escaping would have been a menu that silently never appeared
   * and a test that stayed green.
   */
  test('offer the edits on both kinds of row, and deletion wherever nobody else answers', async () => {
    await api();
    const rowsFor = (command: string): string[] =>
      menuItems()
        .filter((item) => item.command === command)
        .map((item) => /viewItem == ([\w.]+)/u.exec(item.when)?.[1] ?? '')
        .sort();

    for (const command of [
      'gripterm.renameTerminal',
      'gripterm.setTask',
      'gripterm.addNote',
      'gripterm.editTags',
      'gripterm.setColor',
    ]) {
      assert.deepEqual(rowsFor(command), [CONTEXT_LIVE, CONTEXT_OVER].sort(), command);
    }
    /*
     * M2.22: deletion is offered on a finished row of ours AND on a row nobody
     * is answering for. The claim it replaces -- "deletion only on a finished
     * one" -- was true of this window's own records and silent about everybody
     * else's, which is where a row could get stuck for ever.
     */
    assert.deepEqual(
      rowsFor('gripterm.deleteTerminal'),
      [CONTEXT_OVER, CONTEXT_ADOPTABLE, CONTEXT_ABANDONED].sort()
    );
    // M2.13, and the same rule: starting over is offered where the terminal is
    // over. On a live row it would be an offer to make a second one (О3).
    assert.deepEqual(rowsFor('gripterm.startOver'), [CONTEXT_OVER]);
    assert.deepEqual(rowsFor('gripterm.closeTerminal'), [CONTEXT_LIVE]);
    /*
     * M2.14. Adoption is offered on the ONE kind of row that is somebody
     * else's and has something to be done with it -- a window that is gone or
     * has stopped answering. Twice, because a button on the row and an entry in
     * its menu are two contributions of the same command; what matters is that
     * neither of them names a row of ours, where taking over means nothing, or
     * a live foreign row, where it means a second `claude --resume`.
     */
    assert.deepEqual(rowsFor('gripterm.adoptTerminal'), [CONTEXT_ADOPTABLE, CONTEXT_ADOPTABLE]);
  });

  /*
   * M2.15. The cleanup is about the STORE, so it is offered from the title of
   * the list and from nowhere else. On a row it would read as "clean up this
   * terminal", which is what `gripterm.deleteTerminal` already is -- and the
   * two mean different things: one throws away a record a person is looking at,
   * the other takes away what no window can act on any more.
   */
  test('offer the cleanup from the title of the list and not from a row', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('gripterm.cleanUpStorage'), 'cleanUpStorage is not registered');
    assert.deepEqual(
      titleItems()
        .filter((item) => item.command === 'gripterm.cleanUpStorage')
        .map((item) => item.when),
      ['view == gripterm.terminals']
    );
    assert.deepEqual(
      menuItems().filter((item) => item.command === 'gripterm.cleanUpStorage'),
      []
    );
  });

  test('are all registered, including the six M2.7 added', async () => {
    const commands = await vscode.commands.getCommands(true);

    for (const item of menuItems()) {
      assert.ok(commands.includes(item.command), `${item.command} is not registered`);
    }
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

  /**
   * M2.1 against the real profile directory, which is the only place the
   * question is real: the unit tests build a store in a temporary folder, and
   * this machine has one that M1 already wrote settings files into. Adopting
   * that directory rather than refusing it is the whole milestone.
   */
  test('brought the storage directory this machine already had up to version 1', async () => {
    const { readiness } = await api();

    assert.equal(
      readiness.storage.kind,
      'ready',
      readiness.storage.kind === 'refused' ? readiness.storage.reason : ''
    );
    const marker = join(homedir(), '.gripterm', 'version');
    assert.equal(readFileSync(marker, 'utf8').trim(), '1', `${marker} does not say version 1`);
    assert.ok(statSync(join(homedir(), '.gripterm', 'owners')).isDirectory(), 'no owners/');
    assert.ok(statSync(join(homedir(), '.gripterm', 'terminals')).isDirectory(), 'no terminals/');
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
