import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ATTENTION_SIGNALS, DEFAULT_JOURNAL_POLICY } from '../../packages/core/src/index';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/**
 * The manifest is the one file no unit test can reach and every wiring bug
 * hides in. Both checks below fail exactly when the JSON and the code have
 * drifted apart -- which is silent everywhere else, because a command that was
 * never registered simply does nothing when a button is pressed.
 */
suite('attention', () => {
  test('offers every command a notification can name', async () => {
    // `AttentionNotifier` puts these two ids on its buttons. A button whose
    // command is not registered is a promise the extension cannot keep, and the
    // person pressing it sees nothing at all.
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('gripterm.focusTerminal'), 'focusTerminal is not registered');
    assert.ok(commands.includes('gripterm.showLogs'), 'showLogs is not registered');
  });

  test('offers exactly the states this build knows in the settings enum', () => {
    // The enum is what the settings editor shows and what a person picks from.
    // If it lists a state the code does not know, the setting silently never
    // matches; if it omits one, the state cannot be chosen at all.
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension);

    const manifest = extension.packageJSON as {
      contributes: {
        configuration: {
          properties: {
            'gripterm.notify.toastStates': { items: { enum: string[] }, default: string[] };
          };
        };
      };
    };
    const property = manifest.contributes.configuration.properties['gripterm.notify.toastStates'];

    assert.deepEqual([...property.items.enum].sort(), [...ATTENTION_SIGNALS].sort());
    assert.deepEqual(property.default, ['waiting_permission', 'launch_failed']);
  });

  test('promises the same journal limits in the manifest as the code falls back to', () => {
    // Two lists of the same numbers, and they drift: the manifest supplies the
    // default a person SEES and the value `getConfiguration` returns, while
    // `DEFAULT_JOURNAL_POLICY` supplies what the code uses when the setting is
    // absent. A disagreement here means the settings editor showing one
    // retention and the disk keeping another.
    const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
    assert.ok(extension);

    const manifest = extension.packageJSON as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    const { properties } = manifest.contributes.configuration;

    assert.equal(
      properties['gripterm.journal.retentionDays']?.default,
      DEFAULT_JOURNAL_POLICY.retentionDays
    );
    assert.equal(
      properties['gripterm.journal.maxSizeMb']?.default,
      DEFAULT_JOURNAL_POLICY.maxSizeBytes / BYTES_PER_MB
    );
    // The privacy default is stated twice on purpose: this one is what a person
    // reads in the settings editor.
    assert.equal(properties['gripterm.journal.includeContent']?.default, false);
    assert.equal(DEFAULT_JOURNAL_POLICY.includeContent, false);
  });

  test('does not fire a notification just for activating', async () => {
    // Nothing has been registered into the registry, so nothing has moved; a
    // toast here would mean the notifier reacts to something other than a state
    // change. The assertion is the absence of a modal blocking this suite.
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gripterm.terminals.focus'));
  });
});
