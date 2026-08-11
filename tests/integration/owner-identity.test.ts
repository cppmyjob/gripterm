import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The one question about identity that a unit test cannot answer: what this
 * editor actually calls itself. `identifyEditor` is a table matched against a
 * marketing string, and every entry in it is a claim about a real product --
 * checked here against the real product, in the host the suite is running in.
 */
async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

suite('this window', () => {
  test('is recognised as the editor it is actually running in', async () => {
    const { identity } = await api();

    assert.equal(
      identity.editorKind,
      'vscode',
      `this host calls itself ${vscode.env.appName}, and we made ${identity.editorKind} of it`
    );
  });

  test('reads its own process, not somebody else', async () => {
    // The suite runs INSIDE the extension host, so its pid is the one the
    // identity must carry. M2.12 asks the system about exactly this number when
    // deciding whether an owner is still there -- a wrong one there means a
    // living window declared dead and its terminals adopted away.
    const { identity } = await api();

    assert.equal(identity.pid, process.pid);
  });

  test('carries the rest of what the owners file holds', async () => {
    const { identity } = await api();

    assert.equal(identity.kind, 'window');
    assert.equal(identity.editorVersion, vscode.version);
    assert.ok(identity.ownerId.value.length > 0, 'an owner with a blank id owns nothing');
    assert.deepEqual(
      identity.workspaceFolders,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    );
  });
});
