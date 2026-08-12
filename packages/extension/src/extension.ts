import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  AttentionNotifier,
  ClaudeCodeCommandFactory,
  FileEventJournal,
  FileSessionSettingsStore,
  HOOK_EVENT_PATH_PREFIX,
  HookEventParser,
  HookEventServer,
  ObservabilityWatch,
  ProcessLaunchStrategy,
  RequestAuthenticator,
  SessionRegistry,
  ShellLaunchStrategy,
  StorageLayout,
  StorageMigrator,
  SystemClock,
  SystemIdGenerator,
  SystemScheduler,
  TerminalLifecycleService,
  TerminalStateMachine,
  claudeSettingsLocations,
  describeCliVersion,
  findExecutable,
  launchReadiness,
  newActivationToken,
  ownerRefFor,
  probeVersionOutput,
  readClaudeSettings,
  reviewHookPolicies,
  shellKindFor,
} from '@gripterm/core';
import type {
  AgentCommandFactory,
  ExecutableSearch,
  ForwarderScript,
  LaunchLocation,
  LaunchMode,
  LaunchStrategy,
  ListeningAddress,
  Logger,
  OwnerIdentity,
  StoragePreparation,
} from '@gripterm/core';
import { registerCloseTerminal } from './commands/close-terminal';
import { registerFocusTerminal } from './commands/focus-terminal';
import { registerNewTerminal } from './commands/new-terminal';
import { readLaunchLocation, readLaunchMode, readToastSignals } from './settings';
import { UnavailableAgentCommandFactory } from './adapters/unavailable-agent-command-factory';
import { VsCodeLogger } from './adapters/vscode-logger';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';
import { windowIdentity } from './adapters/vscode-window-identity';
import { say } from './ui/say';
import { StatusBarPresenter } from './ui/status-bar-presenter';
import { VsCodeAttentionPresenter } from './ui/vscode-attention-presenter';
import { TERMINALS_VIEW_ID, TerminalTreeDataProvider } from './ui/terminal-tree';

/** The agent this build knows how to start, by the name it goes by on a PATH. */
const CLAUDE_CLI = 'claude';

/** The interpreter the `SessionStart` forwarder is run with (C5-2: never a bare name). */
const FORWARDER_INTERPRETER = 'node';

const FORWARDER_SCRIPT = join('assets', 'gripterm-forwarder.js');

/** Everything this extension writes lives under one directory, named once. */
const STORAGE_DIRECTORY = '.gripterm';

/**
 * How long to wait for `claude --version`. Measured at 264 ms on this machine
 * (2026-08-11) and it does not wait on stdin; this is the ceiling for a machine
 * under load, not an expectation.
 */
const VERSION_TIMEOUT_MS = 10_000;

const MS_PER_SECOND = 1000;

/**
 * What activation established about this machine.
 *
 * Not a published contract -- see `GriptermApi` -- but it is what the
 * integration suite reads to check that the pipeline of M1.14 is composed
 * rather than merely constructed.
 */
export interface Readiness {
  readonly cliPath: string | null;
  readonly cliVersion: string | null;
  readonly forwarder: ForwarderScript | null;
  readonly address: ListeningAddress | null;
  readonly mode: LaunchMode;
  readonly location: LaunchLocation;
  /** Why a launch would be refused, or `null` when it would not. */
  readonly refusal: string | null;
  /** What `~/.gripterm` turned out to be: its schema version, or why it is unusable. */
  readonly storage: StoragePreparation;
}

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
  readonly readiness: Readiness;
}

/**
 * The hook receiver, held outside `activate` because it is the one thing whose
 * shutdown must be AWAITED: `context.subscriptions` takes synchronous
 * disposables, and a port released after the host has gone is a port that was
 * not released.
 */
let receiver: HookEventServer | null = null;

/**
 * Entry point and composition root.
 *
 * Everything with behaviour lives in `adapters/` (the editor as seen by the
 * domain's ports) or in `@gripterm/core`; this file only decides which
 * implementation each port gets, so that the activation path stays readable at
 * a glance. Every rule it looks like it is applying -- which version is
 * acceptable, whether a launch is possible, which settings could silence us --
 * is a function in core with a test, called from here.
 *
 * Asynchronous since M1.14, and unavoidably: the loopback port has to be TAKEN
 * before the first terminal can be told where to post its events, and `claude`
 * has to be FOUND before there is anything to start.
 *
 * It never throws. A window whose extension refused to activate offers no list,
 * no log and no explanation -- so every failure here degrades into a refusal
 * with a sentence attached (`launchReadiness`).
 */
export async function activate(context: vscode.ExtensionContext): Promise<GriptermApi> {
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

  const location = readLaunchLocation(logger);
  const gateway = new VsCodeTerminalGateway(location);
  context.subscriptions.push({ dispose: () => { gateway.dispose(); } });

  const storage = new StorageLayout(join(homedir(), STORAGE_DIRECTORY));
  const store = await prepareStorage(storage, logger);
  // Per activation, held in memory, never written down: it is only meaningful
  // together with the port below, and the two are born and die together (§4.7).
  const token = newActivationToken();
  const address = await listen({ token, storage, registry, logger });
  const cli = await findCli(logger);
  const forwarder = await findForwarder(context, logger);

  const readiness = launchReadiness({ cliName: CLAUDE_CLI, cliPath: cli.path, address });
  const mode = readLaunchMode(logger);

  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway,
    commands: commandFactoryFor(readiness, token, forwarder, storage),
    strategy: strategyFor(mode),
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
  // The check that covers the causes nobody listed, including our own mistakes
  // (§4.7). The policy report below explains; this one detects.
  context.subscriptions.push(
    new ObservabilityWatch({
      registry,
      scheduler: new SystemScheduler(),
      logger,
      announce: ({ entry, silenceMs }) => {
        say(
          'warning',
          `Gripterm is not seeing "${entry.metadata.displayName}": no events in ${Math.round(silenceMs / MS_PER_SECOND)} s. The terminal may be working perfectly — we would not know. See the Gripterm log.`,
          logger
        );
      },
    })
  );

  context.subscriptions.push(registerNewTerminal(lifecycle, registry, logger));
  context.subscriptions.push(registerFocusTerminal(gateway, logger));
  context.subscriptions.push(registerCloseTerminal(lifecycle, registry, logger));
  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );

  // `appName` is logged beside the kind we made of it, unconditionally. An
  // editor we do not recognise then names itself in the one place a person can
  // send us -- which is how the list in `identifyEditor` grows from evidence
  // rather than from guesses.
  logger.info('Gripterm activated', {
    trustedWorkspace: vscode.workspace.isTrusted,
    ownerId: identity.ownerId.value,
    editorKind: identity.editorKind,
    editorVersion: identity.editorVersion,
    appName: vscode.env.appName,
    workspaceFolders: identity.workspaceFolders.length,
    cliPath: cli.path,
    cliVersion: cli.version,
    forwarder: forwarder === null ? null : forwarder.scriptPath,
    listeningOn: address === null ? null : address.origin,
    launchMode: mode,
    launchLocation: location,
    storage: storage.baseDir,
    storageVersion: store.kind === 'ready' ? store.version : null,
  });
  if (readiness.kind === 'refused') {
    logger.warn('Gripterm will refuse to start terminals', { reason: readiness.reason });
  }
  if (address !== null) {
    await reportPolicies(address, identity, logger);
  }

  return {
    registry,
    gateway,
    lifecycle,
    identity,
    readiness: {
      cliPath: cli.path,
      cliVersion: cli.version,
      forwarder,
      address,
      mode,
      location,
      refusal: readiness.kind === 'refused' ? readiness.reason : null,
      storage: store,
    },
  };
}

/**
 * Brings `~/.gripterm` up to the schema this build reads.
 *
 * A refusal is reported and does not stop activation, which is the proportion
 * M2.1 can honestly hold: nothing yet READS a record out of that directory --
 * the repository is still in memory until M2.3 -- so the only thing at stake
 * today is the settings file, and refusing to start terminals over a version
 * marker would cost more than the marker protects. M2.3 is where a refusal
 * starts to mean "do not touch the records", because that is the milestone at
 * which there are records to touch.
 */
async function prepareStorage(layout: StorageLayout, logger: Logger): Promise<StoragePreparation> {
  const prepared = await new StorageMigrator(layout).prepare();
  if (prepared.kind === 'refused') {
    logger.warn('the storage directory is not usable', {
      path: layout.baseDir,
      reason: prepared.reason,
    });
  } else if (prepared.origin === 'adopted') {
    logger.info('a storage directory left by an earlier build was completed', {
      path: layout.baseDir,
      version: prepared.version,
    });
  }
  return prepared;
}

export async function deactivate(): Promise<void> {
  // Everything else is owned by the context. This one is awaited: the socket
  // must be closed before the host lets go, or a reload races its own port.
  const server = receiver;
  receiver = null;
  await server?.stop();
}

/**
 * Takes a loopback port for this activation's hook events.
 *
 * `null` rather than a throw when it cannot: the extension still lists,
 * observes nothing and says why -- which is a better window than no window.
 */
async function listen(parts: {
  readonly token: string;
  readonly storage: StorageLayout;
  readonly registry: SessionRegistry;
  readonly logger: Logger;
}): Promise<ListeningAddress | null> {
  const server = new HookEventServer({
    authenticator: new RequestAuthenticator(parts.token),
    journal: new FileEventJournal(parts.storage),
    sink: parts.registry,
    logger: parts.logger,
  });

  try {
    const address = await server.start();
    receiver = server;
    return address;
  } catch (cause: unknown) {
    parts.logger.error('Gripterm could not take a loopback port for hook events', { cause });
    return null;
  }
}

/** Where `claude` is, and which build it is -- both established by asking it, never by a file. */
async function findCli(logger: Logger): Promise<{ path: string | null, version: string | null }> {
  const path = await findExecutable(CLAUDE_CLI, systemSearch());
  if (path === null) {
    // Not an error: a person may simply not have installed it. The refusal a
    // person actually reads is raised when they ask for a terminal.
    logger.warn('Claude Code was not found on the PATH this window inherited', {
      looked: CLAUDE_CLI,
    });
    return { path: null, version: null };
  }

  const report = describeCliVersion(await probeVersionOutput(path, VERSION_TIMEOUT_MS));
  const details = { path, message: report.message };
  if (report.level === 'warn') {
    logger.warn('the installed Claude Code is not the build this was measured against', details);
  } else {
    logger.info('Claude Code is the build this was measured against', details);
  }
  return { path, version: report.version };
}

/**
 * The interpreter and script for the `SessionStart` forwarder, or `null`.
 *
 * `null` costs exactly one event, and the direction of that refusal is stated
 * in `SessionSettingsParams`: ten hooks keep arriving over HTTP. What goes with
 * it is the `/clear` rename and `ObservedState.pid` (§8.2), which is why the
 * absence is a warning and not silence.
 */
async function findForwarder(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<ForwarderScript | null> {
  const scriptPath = join(context.extensionPath, FORWARDER_SCRIPT);
  const interpreterPath = await findExecutable(FORWARDER_INTERPRETER, systemSearch());

  if (interpreterPath === null) {
    logger.warn('no node on PATH, so SessionStart will not be observed', {
      looked: FORWARDER_INTERPRETER,
      cost: 'a session renamed by /clear, and the pid',
    });
    return null;
  }
  if (!(await isFile(scriptPath))) {
    // Ours to fix, not the person's: the file is shipped inside the extension.
    logger.error('the hook forwarder is missing from this installation', { scriptPath });
    return null;
  }
  return { interpreterPath, scriptPath };
}

/**
 * The PATH as this window inherited it.
 *
 * Which is not necessarily the PATH a terminal will have -- a shell profile can
 * add to it -- and that difference is exactly what `gripterm.launch.mode:
 * shell` exists for.
 */
function systemSearch(): ExecutableSearch {
  return {
    path: process.env.PATH,
    pathExt: process.env.PATHEXT,
    platform: process.platform,
  };
}

function commandFactoryFor(
  readiness: ReturnType<typeof launchReadiness>,
  token: string,
  sessionStart: ForwarderScript | null,
  storage: StorageLayout
): AgentCommandFactory {
  if (readiness.kind === 'refused') {
    return new UnavailableAgentCommandFactory(readiness.reason);
  }
  return new ClaudeCodeCommandFactory({
    executablePath: readiness.cliPath,
    address: readiness.address,
    token,
    sessionStart,
    settings: new FileSessionSettingsStore(storage),
  });
}

function strategyFor(mode: LaunchMode): LaunchStrategy {
  // `vscode.env.shell` is the default shell of this machine, which is the one
  // the editor will start when we hand it no `shellPath`.
  return mode === 'shell'
    ? new ShellLaunchStrategy(shellKindFor(vscode.env.shell))
    : new ProcessLaunchStrategy();
}

/**
 * Reads the settings chain and says what in it could silence us.
 *
 * An explanation, not a detector: it can only find blockers whose names we
 * know, so the thing that NOTICES is `ObservabilityWatch` (§4.7). It runs at
 * activation all the same, so that when a terminal does go quiet the reason is
 * already sitting in the same log, a few lines above.
 */
async function reportPolicies(
  address: ListeningAddress,
  identity: OwnerIdentity,
  logger: Logger
): Promise<void> {
  const read = await readClaudeSettings(
    claudeSettingsLocations({
      platform: process.platform,
      home: homedir(),
      configDir: process.env.CLAUDE_CONFIG_DIR,
      folders: identity.workspaceFolders,
    })
  );

  for (const path of read.unreadable) {
    logger.warn('a Claude Code settings file could not be read, so whatever is in it is not in force', {
      path,
    });
  }
  for (const finding of reviewHookPolicies(read.sources, {
    urlPrefix: `${address.origin}${HOOK_EVENT_PATH_PREFIX}`,
  })) {
    logger.warn('a Claude Code setting can stop Gripterm seeing anything', {
      path: finding.path,
      setting: finding.setting,
      consequence: finding.message,
    });
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
