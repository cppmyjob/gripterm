import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * O5 in the only place it can be checked: a live window that fell back.
 *
 * The criterion is not that the fallback WORKS -- `terminal-gateway-contract`
 * covers that -- but that a person finds out it happened. M3.14 measured the
 * gap by hand in Cursor: the engine fell back exactly as promised, the terminal
 * came up in the editor's own panel, and the owner never saw a word about it.
 *
 * The cause is the editor's, and it is read off the bundle rather than guessed:
 * `PURGE_TIMEOUT={[Info]:15e3,[Warning]:18e3,[Error]:2e4,...}` with
 * `get sticky(){...e&&this._severity===Error...}` -- a warning toast is taken
 * away after eighteen seconds and only an error with buttons stays. Ours is said
 * from `activate`, which is the same second in which a person is answering the
 * question about trusting the folder.
 *
 * So the sentence is said twice, and this suite is what stops the second one
 * from being deleted by somebody who reads it as a duplicate.
 *
 * **Why it cannot be a jest test.** The fallback is a real `require` of a native
 * addon failing inside a real extension host, and the gateway it leaves behind
 * makes a real terminal. Both halves are the platform's.
 */

type MadeGateway = ReturnType<GriptermApi['makeGateway']>;
type Spec = Parameters<MadeGateway['create']>[0];

/** The gateway keys on `.value` alone; the brand exists to stop this happening anywhere but a test. */
function idFor(suffix: string): Spec['terminalId'] {
  return { value: `550e8400-e29b-41d4-a716-4466553${suffix}` } as unknown as Spec['terminalId'];
}

/** A process that exits at once, so no test leaves a shell sitting in the panel. */
function exiting(): { readonly path: string, readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'exit 0'] }
    : { path: '/bin/sh', args: ['-c', 'exit 0'] };
}

const SILENT = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * A window that asked for `own` and cannot have it, plus everything it said.
 *
 * The addon is made unavailable the way a machine does it -- by not being where
 * the extension is -- rather than by a flag of ours. `os.tmpdir()` holds no
 * `assets/node-pty`, so `loadNodePty` fails there for the same reason it fails
 * on Linux, on a copy an antivirus took away, and on a build that never ran.
 */
async function fallenBack(): Promise<{ readonly gateway: MadeGateway, readonly said: string[] }> {
  const said: string[] = [];
  const gateway = (await api()).makeGateway({
    setting: 'own',
    mode: 'process',
    // `panel`, not the default group: a gateway of this suite must not move the
    // editor layout the other suites are looking at.
    location: 'panel',
    extensionPath: os.tmpdir(),
    editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
    ideChannel: false,
    logger: SILENT,
    announce: (message: string) => said.push(message),
  });
  return { gateway, said };
}

suite('a window that could not have the engine it was set to', () => {
  test('says so once when it finds out, naming the setting a person would have to change', async () => {
    const { gateway, said } = await fallenBack();
    try {
      // The fallback itself, live: asked for `own`, answered by the editor's.
      assert.equal(gateway.engine, 'editor', 'the addon loaded from a directory that has none');

      assert.equal(said.length, 1, said.join(' | '));
      // Content, not a golden string: a sentence that named no setting would
      // leave a person looking for a switch they cannot find.
      assert.equal(said[0]?.includes('gripterm.terminal.engine'), true, said[0]);
    } finally {
      gateway.dispose();
    }
  });

  test('says it again when the first terminal appears, and not on the ones after', async () => {
    const { gateway, said } = await fallenBack();
    try {
      const first = await gateway.create({
        terminalId: idFor('01'),
        name: 'gripterm-fallback-1',
        cwd: os.tmpdir(),
        env: {},
        shellPath: exiting().path,
        shellArgs: exiting().args,
      });

      // The whole point of the second sentence: this is the moment the person is
      // certainly looking at the window, because they just asked it for a
      // terminal and got one of a kind they did not ask for.
      assert.equal(said.length, 2, said.join(' | '));
      assert.equal(said[1], said[0], 'the second sentence is not the first one again');

      const second = await gateway.create({
        terminalId: idFor('02'),
        name: 'gripterm-fallback-2',
        cwd: os.tmpdir(),
        env: {},
        shellPath: exiting().path,
        shellArgs: exiting().args,
      });

      // Twice is telling, three times is nagging.
      assert.equal(said.length, 2, said.join(' | '));
      first.dispose();
      second.dispose();
    } finally {
      gateway.dispose();
    }
  });

  test('an engine that was honoured says nothing to anybody', async () => {
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension, 'extension not found in the host');
    const said: string[] = [];
    const gateway = (await api()).makeGateway({
      setting: 'own',
      mode: 'process',
      location: 'panel',
      extensionPath: extension.extensionPath,
      editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
      ideChannel: false,
      logger: SILENT,
      announce: (message: string) => said.push(message),
    });
    try {
      // And this is the other half of the promise: a window that got what it
      // asked for interrupts nobody. The build is what makes this branch real --
      // `build:extension` copies the addon, so a fallback HERE is a broken build.
      assert.equal(gateway.engine, 'own', said.join(' | '));
      assert.deepEqual(said, []);
    } finally {
      gateway.dispose();
    }
  });
});
