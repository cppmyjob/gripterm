import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * What only a real editor can answer about the list: that the view is
 * CONTRIBUTED and registered with the workbench, not merely constructed.
 *
 * How a row looks -- icon, colour, description, `contextValue` -- is settled in
 * `tests/domain/terminal-presentation.test.ts` against the pure presenter,
 * where every state is covered. Repeating that here would test the same table
 * twice and the wiring not at all.
 */
suite('the terminals view', () => {
  test('is registered with the workbench, so the editor offers its focus command', async () => {
    // `<viewId>.focus` is contributed by the platform for every declared view.
    // Its absence is exactly the failure that a manifest typo produces, and the
    // one an in-process check of our own objects would miss.
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes('gripterm.terminals.focus'),
      'the terminals view is not registered with the workbench'
    );
  });

  test('can be revealed', async () => {
    await vscode.commands.executeCommand('gripterm.terminals.focus');
  });
});
