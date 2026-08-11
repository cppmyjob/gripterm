import * as vscode from 'vscode';
import {
  HookEventParser,
  SUPPORTED_CLI_VERSION,
  SessionRegistry,
  SystemClock,
  TerminalStateMachine,
} from '@gripterm/core';
import { VsCodeLogger } from './adapters/vscode-logger';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';

/**
 * What the extension hands back from `activate`.
 *
 * It exists for the integration suite, which is the only place a real editor
 * can be asked whether the wiring works, and it is NOT a published contract:
 * this package is `private`, and the extension API for other extensions is an
 * M3 question. Said here rather than discovered from a breakage later.
 */
export interface GriptermApi {
  readonly registry: SessionRegistry;
  readonly gateway: VsCodeTerminalGateway;
}

/**
 * Entry point and composition root.
 *
 * Everything with behaviour lives in `adapters/` (the editor as seen by the
 * domain's ports) or in `@gripterm/core`; this file only decides which
 * implementation each port gets, so that the activation path stays readable at
 * a glance.
 */
export function activate(context: vscode.ExtensionContext): GriptermApi {
  const output = vscode.window.createOutputChannel('Gripterm', { log: true });
  context.subscriptions.push(output);
  const logger = new VsCodeLogger(output);

  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new SystemClock(),
    logger,
  });

  const gateway = new VsCodeTerminalGateway();
  context.subscriptions.push({ dispose: () => { gateway.dispose(); } });

  logger.info('Gripterm activated', {
    trustedWorkspace: vscode.workspace.isTrusted,
    pinnedCli: SUPPORTED_CLI_VERSION,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );

  return { registry, gateway };
}

export function deactivate(): void {
  // Nothing to tear down here: every disposable is owned by the context.
}
