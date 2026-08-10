import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

// The point of this suite is not the assertion but the run: it proves the
// extension loads inside a real VS Code, which no unit test can show.
suite('activation', () => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension, 'extension not found in the host');

    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('the log command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gripterm.showLogs'));
  });
});
