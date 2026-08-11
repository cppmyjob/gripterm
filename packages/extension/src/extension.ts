import * as vscode from 'vscode';
import {
  AttentionNotifier,
  HookEventParser,
  OwnerId,
  OwnerRef,
  ProcessLaunchStrategy,
  SUPPORTED_CLI_VERSION,
  SessionRegistry,
  SystemClock,
  SystemIdGenerator,
  TerminalLifecycleService,
  TerminalStateMachine,
} from '@gripterm/core';
import { registerCloseTerminal } from './commands/close-terminal';
import { registerFocusTerminal } from './commands/focus-terminal';
import { registerNewTerminal } from './commands/new-terminal';
import { readToastSignals } from './settings';
import { PendingAgentCommandFactory } from './adapters/pending-agent-command-factory';
import { VsCodeLogger } from './adapters/vscode-logger';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';
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
}

/**
 * Entry point and composition root.
 *
 * Everything with behaviour lives in `adapters/` (the editor as seen by the
 * domain's ports) or in `@gripterm/core`; this file only decides which
 * implementation each port gets, so that the activation path stays readable at
 * a glance.
 *
 * Three of those choices are provisional and named as such, all three belonging
 * to M1.14: the owner identity is minted here rather than detected (M1.13), the
 * launch strategy is the default `process` mode rather than what
 * `gripterm.launch.mode` says, and the agent command factory is a refusal.
 */
export function activate(context: vscode.ExtensionContext): GriptermApi {
  const output = vscode.window.createOutputChannel('Gripterm', { log: true });
  context.subscriptions.push(output);
  const logger = new VsCodeLogger(output);

  const clock = new SystemClock();
  const ids = new SystemIdGenerator();
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
    owner: thisWindow(ids),
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

  logger.info('Gripterm activated', {
    trustedWorkspace: vscode.workspace.isTrusted,
    pinnedCli: SUPPORTED_CLI_VERSION,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );

  return { registry, gateway, lifecycle };
}

/**
 * This window, as it will be written on every record it creates.
 *
 * A fresh id per activation, deliberately: ownership is about who may WRITE a
 * record now, and a window that has been restarted is a different writer with
 * different terminals. Detecting which editor this actually is -- Cursor calls
 * itself something else -- is M1.13; until then the honest answer is the one we
 * can check, and `vscode` is what this build runs in.
 */
function thisWindow(ids: SystemIdGenerator): OwnerRef {
  return OwnerRef.create({
    kind: 'window',
    ownerId: OwnerId.fromString(ids.newUuid()),
    editorKind: 'vscode',
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
  });
}

export function deactivate(): void {
  // Nothing to tear down here: every disposable is owned by the context.
}
