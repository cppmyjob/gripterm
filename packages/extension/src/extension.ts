import * as vscode from 'vscode';
import {
  AttentionNotifier,
  HookEventParser,
  ProcessLaunchStrategy,
  SUPPORTED_CLI_VERSION,
  SessionRegistry,
  SystemClock,
  SystemIdGenerator,
  TerminalLifecycleService,
  TerminalStateMachine,
  ownerRefFor,
} from '@gripterm/core';
import type { OwnerIdentity } from '@gripterm/core';
import { registerCloseTerminal } from './commands/close-terminal';
import { registerFocusTerminal } from './commands/focus-terminal';
import { registerNewTerminal } from './commands/new-terminal';
import { readToastSignals } from './settings';
import { PendingAgentCommandFactory } from './adapters/pending-agent-command-factory';
import { VsCodeLogger } from './adapters/vscode-logger';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';
import { windowIdentity } from './adapters/vscode-window-identity';
import { StatusBarPresenter } from './ui/status-bar-presenter';
import { VsCodeAttentionPresenter } from './ui/vscode-attention-presenter';
import { TERMINALS_VIEW_ID, TerminalTreeDataProvider } from './ui/terminal-tree';

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
  readonly lifecycle: TerminalLifecycleService;
  readonly identity: OwnerIdentity;
}

/**
 * Entry point and composition root.
 *
 * Everything with behaviour lives in `adapters/` (the editor as seen by the
 * domain's ports) or in `@gripterm/core`; this file only decides which
 * implementation each port gets, so that the activation path stays readable at
 * a glance.
 *
 * Two of those choices are provisional and named as such, both belonging to
 * M1.14: the launch strategy is the default `process` mode rather than what
 * `gripterm.launch.mode` says, and the agent command factory is a refusal.
 */
export function activate(context: vscode.ExtensionContext): GriptermApi {
  const output = vscode.window.createOutputChannel('Gripterm', { log: true });
  context.subscriptions.push(output);
  const logger = new VsCodeLogger(output);

  const clock = new SystemClock();
  const ids = new SystemIdGenerator();
  const identity = windowIdentity(ids);
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });

  const gateway = new VsCodeTerminalGateway();
  context.subscriptions.push({ dispose: () => { gateway.dispose(); } });

  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway,
    commands: new PendingAgentCommandFactory(),
    strategy: new ProcessLaunchStrategy(),
    ids,
    clock,
    owner: ownerRefFor(identity),
    logger,
  });
  context.subscriptions.push(lifecycle);

  const tree = new TerminalTreeDataProvider(registry);
  context.subscriptions.push(tree);
  context.subscriptions.push(
    vscode.window.createTreeView(TERMINALS_VIEW_ID, { treeDataProvider: tree })
  );
  context.subscriptions.push(new StatusBarPresenter(registry));

  context.subscriptions.push(
    new AttentionNotifier({
      registry,
      presenter: new VsCodeAttentionPresenter(logger),
      signals: readToastSignals(logger),
    })
  );
  context.subscriptions.push(registerNewTerminal(lifecycle, registry, logger));
  context.subscriptions.push(registerFocusTerminal(gateway, logger));
  context.subscriptions.push(registerCloseTerminal(lifecycle, registry, logger));

  // `appName` is logged beside the kind we made of it, unconditionally. An
  // editor we do not recognise then names itself in the one place a person can
  // send us -- which is how the list in `identifyEditor` grows from evidence
  // rather than from guesses.
  logger.info('Gripterm activated', {
    trustedWorkspace: vscode.workspace.isTrusted,
    pinnedCli: SUPPORTED_CLI_VERSION,
    ownerId: identity.ownerId.value,
    editorKind: identity.editorKind,
    editorVersion: identity.editorVersion,
    appName: vscode.env.appName,
    workspaceFolders: identity.workspaceFolders.length,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );

  return { registry, gateway, lifecycle, identity };
}

export function deactivate(): void {
  // Nothing to tear down here: every disposable is owned by the context.
}
