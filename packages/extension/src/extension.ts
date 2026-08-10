import * as vscode from 'vscode';
import { SUPPORTED_CLI_VERSION } from '@gripterm/core';

/**
 * Entry point. Composition belongs in composition/, behaviour in adapters/ and
 * ui/ — this file stays a wiring point so that the activation path is readable
 * at a glance.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Gripterm', { log: true });
  context.subscriptions.push(output);

  output.info(
    `Gripterm activated. Trusted workspace: ${String(vscode.workspace.isTrusted)}. ` +
      `Pinned Claude Code CLI: ${SUPPORTED_CLI_VERSION}.`
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );
}

export function deactivate(): void {
  // Nothing to tear down yet: every disposable is owned by the context.
}
