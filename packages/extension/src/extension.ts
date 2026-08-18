import * as vscode from 'vscode';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  AnnouncingJournal,
  AttentionNotifier,
  BaseProjection,
  BaseWriter,
  ClaudeCodeCommandFactory,
  FileEventJournal,
  FileOwnerPresence,
  FileSessionSettingsStore,
  FileTerminalRepository,
  HOOK_EVENT_PATH_PREFIX,
  HookEventParser,
  HookEventServer,
  ObservabilityWatch,
  DEFAULT_RECONCILE_INTERVAL_MS,
  OwnerHeartbeat,
  Reconciler,
  ProcessLaunchStrategy,
  RepositoryWatcher,
  RequestAuthenticator,
  RestoreOrchestrator,
  SessionNameMirror,
  SessionRegistry,
  ShellLaunchStrategy,
  StorageCleaner,
  StorageLayout,
  StorageMigrator,
  SystemClock,
  SystemIdGenerator,
  SystemScheduler,
  TerminalLifecycleService,
  TerminalMetadataService,
  TerminalStateMachine,
  TerminalTabNamer,
  claudeRenameCommand,
  claudeSessionsDirectory,
  claudeSettingsLocations,
  claudeTranscriptsDirectory,
  describeCliVersion,
  endOwnTerminals,
  findExecutable,
  gatherRestoreInputs,
  isProcessThere,
  launchReadiness,
  newActivationToken,
  ownerRefFor,
  planRestore,
  planUnaskedCleanup,
  sendKillSignal,
  sendSignalZero,
  probeVersionOutput,
  readAgentListing,
  readClaudeSessionName,
  readClaudeSettings,
  readTranscriptIndex,
  reviewHookPolicies,
  shellKindFor,
} from '@gripterm/core';
import type {
  AgentCommandFactory,
  EditorIdentity,
  EventJournal,
  ExecutableSearch,
  ForwarderScript,
  LaunchLocation,
  LaunchMode,
  LaunchStrategy,
  ListeningAddress,
  Logger,
  OwnerIdentity,
  OwnerPresence,
  RestoreInputs,
  StoragePreparation,
  TerminalEngine,
  TerminalGateway,
  TerminalRepository,
  WatchReport,
  WindowShutdownReport,
} from '@gripterm/core';
import { registerAdoptTerminal } from './commands/adopt-terminal';
import { registerCleanUpStorage } from './commands/clean-up-storage';
import { registerCloseTerminal } from './commands/close-terminal';
import { registerDeleteTerminal } from './commands/delete-terminal';
import { registerShowRecord } from './commands/show-record';
import { registerResumeTerminal } from './commands/resume-terminal';
import { registerStartOver } from './commands/start-over';
import { registerFocusTerminal } from './commands/focus-terminal';
import { registerMetadataCommands } from './commands/edit-metadata';
import { registerNewTerminal } from './commands/new-terminal';
import {
  readJournalPolicy,
  readLaunchLocation,
  readLaunchMode,
  readStorageDir,
  readTerminalEngine,
  readToastSignals,
} from './settings';
import { terminalGatewayFor } from './terminal-gateway-factory';
import { UnavailableAgentCommandFactory } from './adapters/unavailable-agent-command-factory';
import { VsCodeLogger } from './adapters/vscode-logger';
import { windowIdentity } from './adapters/vscode-window-identity';
import { say } from './ui/say';
import { StatusBarPresenter } from './ui/status-bar-presenter';
import { VsCodeAttentionPresenter } from './ui/vscode-attention-presenter';
import { TerminalDecorationProvider } from './ui/terminal-decorations';
import { TERMINALS_VIEW_ID, TerminalTreeDataProvider } from './ui/terminal-tree';
import { WORKBENCH_VIEW_ID, WorkbenchView } from './ui/workbench-view';
import { TerminalStage } from './ui/terminal-stage';
import { TERMINAL_FOCUSED_KEY, TerminalKeyboard } from './ui/terminal-keyboard';
import { TerminalDetails } from './ui/terminal-details';
import { TerminalStrip } from './ui/terminal-strip';
import { registerTerminalKey } from './commands/terminal-key';
import type { TerminalTreeNode } from './ui/terminal-tree';

/** The agent this build knows how to start, by the name it goes by on a PATH. */
const CLAUDE_CLI = 'claude';

/** The setting whose change needs a reload, because the whole store moves with it. */
const STORAGE_PATH_SETTING = 'gripterm.storage.path';

/** The interpreter the `SessionStart` forwarder is run with (C5-2: never a bare name). */
const FORWARDER_INTERPRETER = 'node';

const FORWARDER_SCRIPT = join('assets', 'gripterm-forwarder.js');

/**
 * How long to wait for `claude --version`. Measured at 264 ms on this machine
 * (2026-08-11) and it does not wait on stdin; this is the ceiling for a machine
 * under load, not an expectation.
 */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * How long to wait for `claude agents --json`, which a restore asks before it
 * starts anything.
 *
 * The same ceiling as the version probe, and it buys the same thing: a CLI that
 * does not answer leaves the listing `unavailable`, and `unavailable` refuses
 * every restore rather than permitting one. Waiting longer would delay an
 * activation; waiting less would turn a busy machine into a window that brings
 * nothing back.
 */
const AGENT_LISTING_TIMEOUT_MS = 10_000;

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
  /**
   * The engine that ANSWERED, which is not always the one that was asked for.
   *
   * `gripterm.terminal.engine` can say `own` and be refused twice over -- by the
   * shell launch mode, and by a native addon that would not load -- and both
   * refusals end in the editor's gateway. Reported here because a suite that
   * could not tell the two apart would report a green run for an engine it never
   * touched (M1.5, M2.11).
   */
  readonly engine: TerminalEngine;
  /** Why a launch would be refused, or `null` when it would not. */
  readonly refusal: string | null;
  /** What the store turned out to be: its schema version, or why it is unusable. */
  readonly storage: StoragePreparation;
  /** Where the store is, after the setting and the fallback have been applied. */
  readonly storageDir: string;
  /** What became of the terminals this window could have brought back (M2.11). */
  readonly restore: RestoreSummary;
  /**
   * Whether this window is reading the base and watching it.
   *
   * False when the directory could not be prepared or this window could not
   * announce itself -- both of which leave a working window that shows only its
   * own terminals, and both of which the integration suite has to be able to
   * tell from "it works".
   */
  readonly sharing: boolean;
}

/**
 * What activation did about the records left behind by windows that are gone.
 *
 * Three answers and not two, because "we did not try" and "we tried and it broke"
 * send a person to different places -- and because the first of them is the
 * normal answer in a test host, where starting somebody's conversations would be
 * a side effect of running a test suite.
 */
export type RestoreSummary =
  | { readonly kind: 'skipped', readonly reason: string }
  | {
    readonly kind: 'ran';
    readonly planned: number;
    readonly started: number;
    /** Records the planner refused. Every one of them has a reason (M2.10). */
    readonly refused: number;
  }
  | { readonly kind: 'failed', readonly reason: string };

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
  /**
   * The port, not the editor's implementation of it (M3.4).
   *
   * The acceptance suites reach a terminal through `handleFor`, which is now the
   * port's own method: a field typed to the concrete class would make every one
   * of them a test of the `editor` engine, and the same run has to be able to
   * exercise the other one.
   */
  readonly gateway: TerminalGateway;
  /**
   * The composition's own engine choice, handed out so that it can be exercised.
   *
   * Both engines and both refusals live behind one function, and the only place
   * any of it can be run is a real Extension Host -- one of the engines IS the
   * editor. Exposed rather than imported by the suite, and that difference is the
   * point: a test that imported the module would be loading a SECOND compiled
   * copy of it beside the bundle the editor is running, and would be checking
   * that copy. This is the object the person's window uses.
   */
  readonly makeGateway: typeof terminalGatewayFor;
  /**
   * What `deactivate` does to this window's own processes (M3.5).
   *
   * Exposed so that a suite can run the composed thing rather than a copy of it:
   * the rule, the gateway this window is really using and the records it really
   * holds. Safe to call in a test host BECAUSE of the rule -- under the editor's
   * engine it ends nothing and disposes nothing, which is itself the assertion.
   */
  readonly endOwnProcesses: () => WindowShutdownReport;
  readonly lifecycle: TerminalLifecycleService;
  /**
   * The five things a person changes about their own record.
   *
   * Exposed for the acceptance suite of M2.16, where П2 asks whether a task and
   * a note survive a restart: writing them into the record file by hand would
   * check the restore against a record no part of this build ever produced, and
   * the commands that normally write them stand behind an input box a run cannot
   * answer.
   */
  readonly metadata: TerminalMetadataService;
  readonly identity: OwnerIdentity;
  /**
   * The list itself, not merely its data provider.
   *
   * Exposed because `reveal` is the platform's and lives on the view: the
   * `resume_failed` toast presses a button that selects a row, and a real editor
   * is the only place that can be shown to happen (M2.13).
   */
  readonly view: vscode.TreeView<TerminalTreeNode>;
  /**
   * The panel this extension draws in (M3.6).
   *
   * Exposed for the same reason as the gateway: the page reports its own box,
   * its own font and its own content-policy violations, and those reports are
   * the only way anything about a webview can be checked without a person
   * looking at a screen. The suite drives THIS object -- the one the person's
   * window is using -- rather than a second copy of the provider.
   */
  readonly workbench: WorkbenchView;
  /**
   * The owner of "which terminal the panel is showing" (M3.7).
   *
   * Exposed for the same reason as the gateway and for one more: it is the
   * object that holds every terminal's bridge, and the bridges are where the
   * numbers live -- how much was sent, how much is unacknowledged, whether the
   * process is being held back. A suite that could not read those would be
   * asserting on a picture.
   */
  readonly stage: TerminalStage;
  /**
   * Who has the keyboard, and what a chord taken from the editor does (M3.8).
   *
   * Exposed because the refusals are the acceptance: "a key does not reach the
   * pty from the details half" is a sentence this object says, and a suite
   * reading it out of a log would be asserting on a string somebody can reword.
   */
  readonly keyboard: TerminalKeyboard;
  /**
   * The strip of tabs over the terminal (M3.9).
   *
   * Exposed because it is the one place that knows what the host BELIEVES the
   * strip shows, and the page reports what it really drew -- so the two can be
   * compared. A suite reading only one of them would be asserting that the page
   * agrees with itself.
   */
  readonly strip: TerminalStrip;
  /** The details half, and its own count of how often it has read the journal (M3.11). */
  readonly details: TerminalDetails;
  /**
   * This activation's hook token.
   *
   * Handed out so that the suite can deliver an event the way an agent does --
   * a POST to the loopback endpoint -- rather than by calling the registry
   * directly. That difference is the whole of what M3.11 needs to check: only
   * the real path writes the JOURNAL, and the history in the panel comes from
   * the journal and from nowhere else.
   *
   * It discloses nothing: the token lives in memory for one activation, it is
   * already in the environment of every agent this window starts, and this suite
   * runs inside the window that issued it.
   */
  readonly hookToken: string;
  /**
   * The data provider, for the one question only a real host answers about the
   * grouping (M2.14): what the ROOT of the contributed view actually contains.
   * How rows group is decided in `groupTerminals` and covered there.
   */
  readonly tree: TerminalTreeDataProvider;
  readonly readiness: Readiness;
  /** `null` when this window is not reading the shared store. */
  readonly repository: TerminalRepository | null;
  /**
   * The sweep, or `null` in a window with no shared base.
   *
   * Exposed for the integration suite, which is the only place a real
   * `owners/` directory with a real dead window in it can be built.
   */
  readonly reconciler: Reconciler | null;
  /** `null` for the same reason: a restore is an operation on the base. */
  readonly restore: RestoreOrchestrator | null;
}

/**
 * The hook receiver, held outside `activate` because it is the one thing whose
 * shutdown must be AWAITED: `context.subscriptions` takes synchronous
 * disposables, and a port released after the host has gone is a port that was
 * not released.
 */
let receiver: HookEventServer | null = null;

/**
 * This window's presence, held here for the same reason and with one more: its
 * goodbye is a file DELETION, and a window that skipped it looks `unknown` to
 * every other window for the next minute -- which is a minute of terminals that
 * cannot be adopted and a row that says "detached" about a window that simply
 * closed.
 */
let presence: OwnerHeartbeat | null = null;

/**
 * This window's writer, held here because its shutdown is a FLUSH: the last
 * thing that happens to a terminal is its close, and a window that went without
 * writing that down leaves a record claiming to be at work on a tool that
 * stopped running when the editor did.
 */
let scribe: BaseWriter | null = null;

/**
 * What this window does to its own processes on the way out (M3.5, O4).
 *
 * Held here rather than left to `context.subscriptions` for two reasons, and
 * both are about the moment it happens. The subscriptions are disposed AFTER
 * `deactivate` resolves, so a flush that took its time would spend the shutdown
 * budget before anything killed anything; and the second half of the act -- a
 * synchronous `process.kill` on the pid we wrote down -- has to run while this
 * host is still there to run it.
 *
 * `null` under the editor's engine is not what stops it: the rule itself refuses
 * that engine (O5). This is `null` only before activation has got that far.
 */
let farewell: (() => WindowShutdownReport) | null = null;

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

  /*
   * The panel tab, the page inside it, and the one object that knows which
   * terminal that page is showing (M3.6, M3.7).
   *
   * Built HERE, before the gateway, and that order is the design: a terminal of
   * our own starts talking the instant it is spawned, and the audience has to
   * exist before the first one can be made or its first bytes -- which are the
   * ones that say why a launch failed -- would reach nobody.
   *
   * `retainContextWhenHidden: true` is the owner's decision of 2026-08-17, taken
   * on the M3.1 measurement: with it, ten hide-and-shows over five sessions
   * never rebuilt the page. The panel is hidden and shown many times a day --
   * `Ctrl+J`, and every switch to TERMINAL -- and a rebuilt page would cost the
   * person their scrollback, their selection and the position of their cursor
   * each time. What it costs instead is the memory of every hidden terminal,
   * which was NOT measured and is named unmeasured in the plan; and what it
   * requires is in `TerminalBridge`: a hidden webview has its timers throttled
   * by Chromium, so invisibility lifts back-pressure unconditionally.
   */
  const workbench = new WorkbenchView({ extensionUri: context.extensionUri, logger });
  context.subscriptions.push(workbench);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WORKBENCH_VIEW_ID, workbench, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  const stage = new TerminalStage({ view: workbench, scheduler: new SystemScheduler(), logger });
  context.subscriptions.push(stage);
  /*
   * The keyboard of the panel (M3.8).
   *
   * The context key is set from here and nowhere else, and the two editor
   * objects it needs -- the clipboard and `setContext` -- are handed in rather
   * than reached for, so the rule about WHEN a chord is passed on stays a rule
   * about our own state.
   */
  const keyboard = new TerminalKeyboard({
    view: workbench,
    stage,
    clipboard: {
      read: async () => await vscode.env.clipboard.readText(),
      write: async (text) => { await vscode.env.clipboard.writeText(text); },
    },
    announce: (focused) => {
      void vscode.commands.executeCommand('setContext', TERMINAL_FOCUSED_KEY, focused);
    },
    logger,
  });
  context.subscriptions.push(keyboard);
  context.subscriptions.push(registerTerminalKey(keyboard));
  /*
   * The strip of tabs over the terminal (M3.9).
   *
   * It is built from the stage and the registry and owns nothing: which
   * terminals the panel holds is the stage's answer, what each is called and
   * doing is the registry's, and how the two become a tab is one rule in the
   * core -- the same one the tree draws its rows with.
   */
  const strip = new TerminalStrip({ view: workbench, stage, registry, logger });
  context.subscriptions.push(strip);

  const location = readLaunchLocation(logger);
  // Read here rather than where it used to be read, further down: the engine is
  // chosen from BOTH settings, because a terminal of our own has no shell to type
  // a launch line into (`chooseEngine`).
  const mode = readLaunchMode(logger);
  const gateway = terminalGatewayFor({
    setting: readTerminalEngine(logger),
    mode,
    location,
    extensionPath: context.extensionPath,
    editor: editorIdentity(),
    logger,
    audience: stage,
  });
  // Still a subscription as well, and deliberately: `deactivate` covers the
  // ordinary way out, this covers the extension being disabled under a window
  // that stays open. Both ends are idempotent -- a gateway that has let go of
  // its terminals has none to let go of twice.
  context.subscriptions.push({ dispose: () => { gateway.dispose(); } });
  const endOwnProcesses = (): WindowShutdownReport =>
    endOwnTerminals({ gateway, entries: registry.own(), endProcess: sendKillSignal, logger });
  farewell = endOwnProcesses;

  const storage = new StorageLayout(readStorageDir(logger));
  const store = await prepareStorage(storage, logger);
  const shared = await shareTheBase({ context, storage, store, registry, identity, clock, logger });
  // Per activation, held in memory, never written down: it is only meaningful
  // together with the port below, and the two are born and die together (§4.7).
  const token = newActivationToken();
  const journal = readJournalPolicy(logger);
  /*
   * The store's own cleanup, and the daily pass over the trash (M2.15).
   *
   * Only where there is a shared base, for the same reason as the sweep: a
   * window reading nothing has no store to tidy, and one that could not open
   * the base is the last thing that should be moving directories inside it.
   *
   * It takes the JOURNAL's retention, deliberately -- one answer to "how long
   * does this build keep things", so that a person who set it once is not
   * surprised by a second number they never saw.
   */
  const cleaner =
    shared === null
      ? null
      : new StorageCleaner({
        layout: storage,
        clock,
        scheduler: new SystemScheduler(),
        logger,
        retentionDays: journal.retentionDays,
      });
  if (cleaner !== null) {
    context.subscriptions.push(cleaner);
  }
  /*
   * The journal, wrapped in the one thing the panel needs from it: a word after
   * each write has landed (M3.11). The wrapper is here rather than inside
   * `listen` because two consumers now share the object -- the receiver writes
   * to it, the details half listens to it -- and a composition root is where
   * that is visible.
   */
  const events = new AnnouncingJournal(
    new FileEventJournal({ layout: storage, logger, policy: journal })
  );
  const details = new TerminalDetails({
    view: workbench,
    stage,
    registry,
    storage,
    journal: events,
    logger,
  });
  context.subscriptions.push(details);
  const address = await listen({ token, registry, logger, journal: events });
  const cli = await findCli(logger);
  const forwarder = await findForwarder(context, logger);

  const readiness = launchReadiness({ cliName: CLAUDE_CLI, cliPath: cli.path, address });

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

  /*
   * The sweep, and the two things it is wired to besides its own timer.
   *
   * It exists only where there is a shared base: a window reading nothing has
   * no other windows to be right or wrong about, and every record it holds is
   * its own and live by construction.
   *
   * Both out-of-turn triggers go through `sweepIfStale`, which is what keeps
   * them from being a process spawner -- each pass runs `claude agents --json`.
   * The base-change trigger is why watching `owners/` was worth doing (§4.8):
   * another window retiring rewrites that directory, and without this the news
   * would wait up to the whole interval.
   */
  const reconciler = shared === null
    ? null
    : new Reconciler({
      repository: shared.repository,
      registry,
      presence: shared.presence,
      self: identity.ownerId,
      readAgents: async () =>
        readiness.kind === 'refused'
          ? { kind: 'unavailable', reason: readiness.reason }
          : await readAgentListing(readiness.cliPath, AGENT_LISTING_TIMEOUT_MS),
      isRunning: (pid) => isProcessThere(pid, sendSignalZero),
      endProcess: sendKillSignal,
      clock,
      scheduler: new SystemScheduler(),
      logger,
      intervalMs: readReconcileInterval(logger),
      uptimeSeconds: uptime,
    });
  if (reconciler !== null && shared !== null) {
    context.subscriptions.push(reconciler);
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void reconciler.sweepIfStale();
        }
      })
    );
    context.subscriptions.push(
      shared.repository.watch(() => {
        void reconciler.sweepIfStale();
      })
    );
  }

  const tree = new TerminalTreeDataProvider({
    registry,
    reconciler,
    // The folders of THIS window, which is what puts its own project at the top
    // of a list that shows every project on the machine (П4).
    windowFolders: identity.workspaceFolders,
  });
  context.subscriptions.push(tree);
  // Held, not just disposed of: `gripterm.showRecord` reveals a row through it,
  // and a data provider alone cannot select anything (M2.13).
  const view = vscode.window.createTreeView(TERMINALS_VIEW_ID, { treeDataProvider: tree });
  context.subscriptions.push(view);
  // The person's own colour, on the row's label. The icon's colour belongs to
  // the state, and the two must not be confusable (M2.7).
  const decorations = new TerminalDecorationProvider(registry);
  context.subscriptions.push(decorations);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  context.subscriptions.push(new StatusBarPresenter(registry));

  context.subscriptions.push(
    new AttentionNotifier({
      registry,
      presenter: new VsCodeAttentionPresenter(logger),
      signals: readToastSignals(logger),
    })
  );
  // The checks that cover the causes nobody listed, including our own mistakes
  // (§4.7). The policy report below explains; these detect.
  context.subscriptions.push(
    new ObservabilityWatch({
      registry,
      scheduler: new SystemScheduler(),
      logger,
      announce: (report) => {
        say('warning', sentenceFor(report), logger);
      },
    })
  );

  const metadata = new TerminalMetadataService({ registry, clock, logger });

  // The editor's tab, kept on the same name as the row -- from one place, so
  // that neither of the two things that rename a terminal has to remember to do
  // it (M2.17).
  context.subscriptions.push(new TerminalTabNamer({ registry, gateway, logger }));

  /*
   * `/rename`, typed inside a terminal, arriving on the row.
   *
   * The CLI offers no hook for it: it writes the new name into its own session
   * file, named after the pid of the process holding the conversation -- which
   * is the pid the editor told us about when it started that terminal. So this
   * needs nothing of the CLI's cooperation and works even for a terminal whose
   * hooks never arrived.
   *
   * Started in every window, including one with no `claude` on the PATH: the
   * cost of a pass with nothing to read is a loop over an empty list, and a
   * window that decided at activation not to watch would go on not watching
   * after the person installed the CLI.
   */
  const names = new SessionNameMirror({
    registry,
    scheduler: new SystemScheduler(),
    logger,
    read: async (pid, conversation) =>
      await readClaudeSessionName(
        claudeSessionsDirectory({
          platform: process.platform,
          home: homedir(),
          configDir: process.env.CLAUDE_CONFIG_DIR,
        }),
        pid,
        conversation
      ),
    // And the way back (M2.19): the CLI has no channel for a rename but the one
    // a person has, so this types it. The guards that decide WHEN are in the
    // mirror -- only while that terminal is idle, and once per name.
    tell: (terminalId, name) => {
      gateway.handleFor(terminalId)?.sendText(claudeRenameCommand(name), true);
    },
  });
  context.subscriptions.push(names);
  names.start();

  // Built whether or not it is about to be used: the integration suite drives a
  // restore of its own record through it, in the one place where a real
  // `claude --resume` and a real terminal can be watched (A9).
  const orchestrator = shared === null
    ? null
    : new RestoreOrchestrator({
      repository: shared.repository,
      registry,
      lifecycle,
      scheduler: new SystemScheduler(),
      logger,
    });
  if (orchestrator !== null) {
    context.subscriptions.push(orchestrator);
  }

  /*
   * The world a restore predicate needs, gathered one way for both paths.
   *
   * Activation uses it to decide what this window brings back by itself, and
   * `gripterm.adoptTerminal` uses it to answer a person who asked for one record
   * by name. Two gatherers would disagree somewhere nobody looks, and what they
   * would disagree about is whether a `claude` is already running that
   * conversation.
   */
  const gather: (() => Promise<RestoreInputs>) | null =
    shared === null
      ? null
      : async () =>
        await gatherRestoreInputs({
          repository: shared.repository,
          presence: shared.presence,
          windowFolders: identity.workspaceFolders,
          readTranscripts: async () =>
            await readTranscriptIndex(
              claudeTranscriptsDirectory({
                platform: process.platform,
                home: homedir(),
                configDir: process.env.CLAUDE_CONFIG_DIR,
              })
            ),
          readAgents: async () =>
            readiness.kind === 'refused'
              ? { kind: 'unavailable', reason: readiness.reason }
              : await readAgentListing(readiness.cliPath, AGENT_LISTING_TIMEOUT_MS),
          // Both from one instant, because the boot rule subtracts one from the
          // other (`precedesBoot`).
          nowMs: Date.now(),
          uptimeSeconds: uptime(),
          logger,
        });

  context.subscriptions.push(
    registerNewTerminal(
      lifecycle,
      registry,
      logger,
      // Only where a panel of ours is what the person would be looking at. Under
      // the editor's engine the editor shows the terminal itself, so there is
      // nothing to wait for and waiting would be a delay bought with nothing.
      gateway.engine === 'own' ? async (): Promise<string | null> => await stage.whenPageIsUp() : null
    )
  );
  context.subscriptions.push(registerFocusTerminal(gateway, logger));
  context.subscriptions.push(registerCloseTerminal(lifecycle, registry, logger));
  context.subscriptions.push(
    registerDeleteTerminal({
      lifecycle,
      registry,
      // Both or neither, and only where there is a shared base: throwing away
      // another window's record needs the store to move the directory in and the
      // sweep to say that nobody is answering for it (M2.22). A window without
      // one holds no record of anybody else's to throw away.
      base: cleaner === null || reconciler === null ? null : { cleaner, reconciler },
      logger,
    })
  );
  context.subscriptions.push(registerStartOver(lifecycle, registry, logger));
  context.subscriptions.push(registerResumeTerminal({ lifecycle, registry, gather, logger }));
  context.subscriptions.push(registerShowRecord(view, tree, logger));
  context.subscriptions.push(
    registerAdoptTerminal({
      registry,
      // All three or none: they are what a shared base is made of, and a window
      // without one holds no record of anybody else's to take.
      base:
        reconciler === null || orchestrator === null || gather === null
          ? null
          : { reconciler, orchestrator, gather },
      logger,
    })
  );
  context.subscriptions.push(
    registerCleanUpStorage({
      // Both or neither: the cleanup moves files by a predicate, and the
      // predicate is exactly the world `gather` reads. A cleanup with a store
      // and no world would be a rule with nothing to apply.
      base:
        cleaner === null || gather === null
          ? null
          : { cleaner, gather, retentionDays: journal.retentionDays },
      logger,
    })
  );
  context.subscriptions.push(...registerMetadataCommands(metadata, registry, logger));
  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );
  // The one configuration key this build listens to, and it listens in order to
  // say that listening is not enough. Everything downstream of the storage path
  // -- this window's presence file, the watcher, the journal, and the
  // `settings.json` the running CLIs have already read -- is built once at
  // activation, so a change that silently moved only the watcher would leave
  // this window observing a directory nothing writes to.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(STORAGE_PATH_SETTING)) {
        say(
          'info',
          'Gripterm reads its storage path once, when the window loads. Reload the window to move the store.',
          logger
        );
      }
    })
  );

  // BEFORE the machine is read, not merely before the restore (M3.5). The world
  // below is gathered once and every gate of the restore is answered from it, so
  // a process ended after that gathering would still be counted as running --
  // and the records of the window that left it behind would be refused while
  // nothing was running them at all.
  await endTheirProcesses({ context, reconciler, logger });

  // One reading for both of the decisions below -- see `surveyTheMachine`.
  const world = await surveyTheMachine({ context, gather, logger });
  const restore = await bringTerminalsBack({ world, orchestrator, readiness, logger });
  // After the restore and against the SAME reading: the two plans are disjoint
  // by construction (M2.15), and a record this window has just adopted is one
  // whose owner is now alive, which no cleanup touches.
  await forgetClosedTerminals({ world, cleaner, logger });

  // After the restore, not before: a sweep that ran first would look at records
  // this window is about to adopt and start, and the first thing it would find
  // is that their processes are gone -- which they are, for another second.
  if (reconciler !== null) {
    await reconciler.sweep();
    reconciler.start();
  }

  /*
   * The pass over the trash: one now, then daily.
   *
   * The one now is the one that matters -- most windows do not live a day, so
   * without it the retention would be a rule nothing ever applies. It is not
   * awaited: nothing downstream depends on it, and a person opening an editor
   * should not wait on a directory listing to see their terminals.
   *
   * Two windows starting at once may sweep the same batch. Whichever loses
   * meets a directory that is already gone, says so and carries on -- there is
   * nothing to be right about in a batch neither of them wanted.
   */
  if (cleaner !== null) {
    void cleaner.collect().catch((cause: unknown) => {
      logger.warn('the trash could not be swept at activation, so it may hold more than it should', {
        reason: String(cause),
      });
    });
    cleaner.start();
  }

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
    sharingTheBase: shared !== null,
    restore: restore.kind === 'ran' ? restore.started : restore.kind,
    journalKeepsContent: journal.includeContent,
    journalRetentionDays: journal.retentionDays,
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
    makeGateway: terminalGatewayFor,
    endOwnProcesses,
    lifecycle,
    metadata,
    identity,
    view,
    tree,
    workbench,
    stage,
    keyboard,
    strip,
    /**
     * The details half of the panel (M3.11).
     *
     * Exposed for the reason the strip is: this object knows what the host
     * BELIEVES the half says, the page reports what it really drew, and a suite
     * reading only one of them would be asserting that a side agrees with
     * itself. It also counts its own reads of the journal, which is the only
     * way "it follows a signal rather than a clock" can be measured.
     */
    details,
    hookToken: token,
    readiness: {
      cliPath: cli.path,
      cliVersion: cli.version,
      forwarder,
      address,
      mode,
      location,
      engine: gateway.engine,
      refusal: readiness.kind === 'refused' ? readiness.reason : null,
      storage: store,
      storageDir: storage.baseDir,
      sharing: shared !== null,
      restore,
    },
    repository: shared?.repository ?? null,
    restore: orchestrator,
    reconciler,
  };
}

/**
 * Brings back the terminals of windows that are gone -- the whole of П2, and the
 * one thing a person notices about M2.
 *
 * It refuses in three situations, and each refusal is a sentence rather than a
 * silence. Two of them are `surveyTheMachine`'s -- a test host, and a window
 * with no shared base to read -- and the third is its own:
 *
 *   * **a launch pipeline that would refuse.** Every start would throw, and each
 *     one would leave a record adopted by this window with no process behind it
 *     (see `RestoreOrchestrator._restore`). Asking first costs nothing; finding
 *     out record by record costs the person a row for every terminal they had.
 *
 * Everything else it catches. `activate` never throws (see its note), and a
 * restore that failed halfway is a window with fewer terminals than it hoped
 * for -- not a window with no list, no log and no explanation.
 */
async function bringTerminalsBack(parts: {
  readonly world: MachineSurvey;
  readonly orchestrator: RestoreOrchestrator | null;
  readonly readiness: ReturnType<typeof launchReadiness>;
  readonly logger: Logger;
}): Promise<RestoreSummary> {
  const { world, readiness, orchestrator, logger } = parts;
  if (world.kind === 'unread') {
    return refuse(world.reason, logger);
  }
  if (orchestrator === null) {
    return refuse('this window is not reading the shared store', logger);
  }
  if (readiness.kind === 'refused') {
    return refuse(readiness.reason, logger);
  }

  try {
    const plan = planRestore(world.inputs);
    const report = await orchestrator.run(plan);
    return {
      kind: 'ran',
      planned: plan.steps.length,
      started: report.started,
      refused: report.skipped.length,
    };
  } catch (cause: unknown) {
    logger.error('this window could not bring its terminals back', { reason: String(cause) });
    return { kind: 'failed', reason: String(cause) };
  }
}

/**
 * One reading of the machine, for both of the decisions activation takes about
 * other windows' records.
 *
 * Read ONCE and shared, which is a rule rather than a saving. `planRestore` and
 * `planUnaskedCleanup` are two readings of one moment, and the invariant between
 * them -- no record is in both answers -- is a property of the VALUE they are
 * given (M2.15). Two gatherings would also be two `claude agents --json`, which
 * is 0.56-0.70 s apiece (A24), spent at the moment a person is waiting for their
 * list.
 *
 * The two refusals here are the ones that belong to reading the machine at all.
 * A launch pipeline that would refuse is NOT one of them: that stops terminals
 * being started, and it has nothing to say about a record whose terminal a
 * person closed -- a store may be tidied on a machine with no `claude` on it.
 */
type MachineSurvey =
  | { readonly kind: 'read', readonly inputs: RestoreInputs }
  | { readonly kind: 'unread', readonly reason: string };

/**
 * Ends the processes of windows that are gone, before anything else looks at the
 * machine (M3.5, O4).
 *
 * **Refused in a test host, for a sharper version of `surveyTheMachine`'s
 * reason.** That one would start somebody's conversations as a side effect of a
 * test run; this one would END them, and nothing takes that back. The
 * integration suite drives the pass explicitly instead, over a record and a
 * process it made itself.
 *
 * A window with no shared base has no other window's records to read, so there
 * is nothing for it to do here.
 *
 * Nothing it does stops an activation. A failure is already a sentence in the
 * log (`endOrphanedProcesses` catches its own), and a window that could not tidy
 * the machine is a window with somebody's process still running -- which is what
 * it had a moment ago.
 */
async function endTheirProcesses(parts: {
  readonly context: vscode.ExtensionContext;
  readonly reconciler: Reconciler | null;
  readonly logger: Logger;
}): Promise<void> {
  if (parts.context.extensionMode === vscode.ExtensionMode.Test) {
    parts.logger.info('this window ended nobody\'s processes', {
      reason: 'this is a test host, and a test run must not end anybody\'s conversations',
    });
    return;
  }
  if (parts.reconciler === null) {
    return;
  }

  const report = await parts.reconciler.endOrphanedProcesses();
  if (report.ended.length > 0 || report.survived.length > 0) {
    parts.logger.info('processes left behind by windows that are gone were ended', {
      ended: report.ended.length,
      survived: report.survived.length,
    });
  }
}

async function surveyTheMachine(parts: {
  readonly context: vscode.ExtensionContext;
  readonly gather: (() => Promise<RestoreInputs>) | null;
  readonly logger: Logger;
}): Promise<MachineSurvey> {
  if (parts.context.extensionMode === vscode.ExtensionMode.Test) {
    // A suite that ran would adopt this machine's records and start `claude
    // --resume` on the person's own conversations -- and, since M2.20, would
    // also move their closed ones into the trash -- as a side effect of running
    // tests. The integration suite drives both explicitly instead.
    return {
      kind: 'unread',
      reason: 'this is a test host, and a test run must not touch anybody\'s conversations',
    };
  }
  if (parts.gather === null) {
    return { kind: 'unread', reason: 'this window is not reading the shared store' };
  }
  try {
    return { kind: 'read', inputs: await parts.gather() };
  } catch (cause: unknown) {
    parts.logger.error('this window could not read the machine, so it changed nothing about it', {
      reason: String(cause),
    });
    return { kind: 'unread', reason: String(cause) };
  }
}

/**
 * Forgets the records of terminals a person closed on purpose, once the windows
 * that held them are gone (M2.20).
 *
 * **Why it is automatic, when M2.15's cleanup asks.** A closed record outlives
 * its window and cannot be acted on from any other one: it belongs to somebody
 * else, and a record whose terminal is over has nothing to take over -- so its
 * row is `CONTEXT_FOREIGN`, which has no menu entries at all. The owner met
 * exactly that on 2026-08-13 and reported it as "it is impossible to close the
 * terminals I no longer need". A person who has closed a terminal has already
 * said what they want; asking them a second time, in a dialog they have to find
 * from a view title, is asking them to repeat themselves in order to be obeyed.
 *
 * **What keeps it safe is the predicate, not the caller.** `planUnaskedCleanup`
 * is `planCleanup` with one reason allowed through, so every guard the confirmed
 * cleanup has this one has: a window merely silent keeps its records, another
 * project's records are not this window's business, and anything any window
 * could still resume stays where it is. And it is not deletion -- each record
 * moves whole into `trash/<stamp>/`, so the way back is moving a folder (§I.3).
 *
 * A failure is reported and survived, like everything else at activation: a
 * store that could not be tidied is a store with more rows in it, which is what
 * it had a moment ago anyway.
 */
async function forgetClosedTerminals(parts: {
  readonly world: MachineSurvey;
  readonly cleaner: StorageCleaner | null;
  readonly logger: Logger;
}): Promise<void> {
  const { world, cleaner, logger } = parts;
  if (world.kind === 'unread' || cleaner === null) {
    return;
  }

  const plan = planUnaskedCleanup(world.inputs);
  if (plan.sweep.length === 0) {
    return;
  }

  try {
    // Named one by one BEFORE they move, and at `info` rather than lower: this
    // is the one thing in the build that takes a person's record away without
    // asking, so the log has to be able to answer "where did that row go".
    for (const item of plan.sweep) {
      logger.info('a record is being forgotten, because its terminal was closed and its window is gone', {
        terminalId: item.entry.terminalId.value,
        name: item.entry.metadata.displayName,
        owner: item.entry.owner.ownerId.value,
      });
    }
    const outcome = await cleaner.sweep(plan.sweep.map((item) => item.entry.terminalId.value));
    logger.info('records of terminals that were closed on purpose were moved to the trash', {
      moved: outcome.moved.length,
      failed: outcome.failed.length,
      batch: outcome.batch,
      kept: plan.kept,
    });
  } catch (cause: unknown) {
    logger.warn('the records of closed terminals could not be moved to the trash', {
      reason: String(cause),
    });
  }
}

function refuse(reason: string, logger: Logger): RestoreSummary {
  logger.info('this window did not try to bring any terminals back', { reason });
  return { kind: 'skipped', reason };
}

/**
 * What the watch found, in a sentence.
 *
 * Both say the same thing about the same thing -- the row you are looking at is
 * not tracking that terminal -- and both name the cost rather than the cause: a
 * person cannot act on "the SessionStart hook did not arrive", and the log,
 * which the sentence sends them to, has the cause a few lines up.
 *
 * The second one names the conversation that was lost, and that is the part
 * worth typing out: `/clear` deletes nothing, so `claude --resume <id>` still
 * reaches the conversation the row has stopped following.
 */
function sentenceFor(report: WatchReport): string {
  const name = report.entry.metadata.displayName;
  if (report.kind === 'silent') {
    return `Gripterm is not seeing "${name}": no events in ${Math.round(report.silenceMs / MS_PER_SECOND)} s. The terminal may be working perfectly — we would not know. See the Gripterm log.`;
  }
  return `Gripterm has lost track of "${name}": it is answering a conversation nothing announced, so its row is out of date. The conversation is ${report.sessionId.value}. See the Gripterm log.`;
}

/** The two halves of the base a restore needs: the records, and who is out there. */
interface SharedBase {
  readonly repository: TerminalRepository;
  readonly presence: OwnerPresence;
}

/**
 * Joins this window to the base every window on the machine shares.
 *
 * Four things in one movement, because none of them is any use without the
 * others: this window announces itself and starts beating; the repository is
 * built on that presence, since adoption is a question about liveness; the
 * watcher is attached to `terminals/` and `owners/`; and both its signal and the
 * repository's own writes lead to one re-read that hands the result to the
 * registry (§4.6).
 *
 * Returns the two halves a restore needs, or `null` when none of it happened. It
 * is refused, rather than half-done, in two cases -- an unusable directory and a
 * window that could not write its own presence file -- and both leave a working
 * window that shows only its own terminals. That is the honest degradation:
 * reading a base this window cannot write itself into would show other windows'
 * terminals as adoptable while this window is invisible to them, which is the one
 * shape §4.8 forbids.
 */
async function shareTheBase(parts: {
  readonly context: vscode.ExtensionContext;
  readonly storage: StorageLayout;
  readonly store: StoragePreparation;
  readonly registry: SessionRegistry;
  readonly identity: OwnerIdentity;
  readonly clock: SystemClock;
  readonly logger: Logger;
}): Promise<SharedBase | null> {
  const { context, storage, registry, identity, clock, logger } = parts;
  if (parts.store.kind === 'refused') {
    logger.warn('this window will not read the shared store, so it lists only its own terminals', {
      path: storage.baseDir,
      reason: parts.store.reason,
    });
    return null;
  }

  const scheduler = new SystemScheduler();
  const owner = new FileOwnerPresence({ layout: storage, clock, logger });
  const heartbeat = new OwnerHeartbeat({ presence: owner, scheduler, logger });
  try {
    await heartbeat.start(identity);
  } catch (cause: unknown) {
    logger.error('this window could not announce itself, so it lists only its own terminals', {
      path: storage.ownersDir,
      reason: String(cause),
    });
    return null;
  }
  presence = heartbeat;
  context.subscriptions.push(heartbeat);

  const repository = new FileTerminalRepository({
    layout: storage,
    owner: ownerRefFor(identity),
    presence: owner,
    clock,
    logger,
  });
  const projection = new BaseProjection({
    repository,
    registry,
    owner: ownerRefFor(identity),
    logger,
  });
  context.subscriptions.push(projection);

  // The other direction, and the reason this window is a writer of the base and
  // not only a reader of it (M2.6). Started before anything can register a
  // terminal, though it does not depend on that -- it takes whatever the
  // registry already holds.
  const writer = new BaseWriter({ repository, registry, scheduler, logger });
  scribe = writer;
  context.subscriptions.push(writer);
  writer.start();

  const watcher = new RepositoryWatcher({ layout: storage, scheduler, logger });
  context.subscriptions.push(watcher);
  // One signal, not two. The repository's own `watch` was subscribed here until
  // M2.6 gave this window something to write, and it then had a cost and no
  // effect: a re-read provoked by OUR write can only produce what the registry
  // already holds -- `replaceForeign` skips the records we own -- so it was a
  // full read of the base per write for nothing. What this window does to its
  // own list, it sees through the registry; what other windows do, it sees here.
  context.subscriptions.push(watcher.watch(() => void projection.refresh()));
  watcher.start();
  // The base as it is right now, before anything changes: a window that only
  // reacted to changes would show an empty list until somebody else moved.
  await projection.refresh();
  return { repository, presence: owner };
}

/**
 * Brings the store up to the schema this build reads.
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
  /*
   * FIRST, and before anything is awaited (M3.5, O4).
   *
   * Everything else in this function writes down what has already happened, and
   * can be caught up with; this is the one act that has to happen while the
   * processes and this host are both still there. A window whose flush took its
   * time would otherwise spend the platform's shutdown budget before a single
   * `claude` of ours was ended.
   *
   * Under the editor's engine it does nothing at all, by its own rule: those
   * terminals are the editor's and a `claude` in one of them outlives the host
   * on purpose (O5).
   */
  const ending = farewell;
  farewell = null;
  ending?.();

  // Everything else is owned by the context. These three are awaited, and their
  // order is the design rather than the order they were written in: stop taking
  // events, write down what we have, and only then say we are gone. Reversed, a
  // window would announce its absence while still writing -- which is an
  // invitation to another window to adopt a record we are in the middle of.
  const server = receiver;
  receiver = null;
  // Before the writer, or an event arriving mid-flush would be observed and
  // never written. A port released after the host has gone is a port that was
  // not released, which is why this one is awaited at all.
  await server?.stop();

  const writer = scribe;
  scribe = null;
  await writer?.stop();

  const keeper = presence;
  presence = null;
  // The presence file must be gone before this window is, or it looks `unknown`
  // to every other window for a minute after it has plainly closed.
  await keeper?.stop();
}

/**
 * Takes a loopback port for this activation's hook events.
 *
 * `null` rather than a throw when it cannot: the extension still lists,
 * observes nothing and says why -- which is a better window than no window.
 */
async function listen(parts: {
  readonly token: string;
  readonly registry: SessionRegistry;
  readonly logger: Logger;
  readonly journal: EventJournal;
}): Promise<ListeningAddress | null> {
  const server = new HookEventServer({
    authenticator: new RequestAuthenticator(parts.token),
    journal: parts.journal,
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
/**
 * What this editor calls itself to a program running inside one of its terminals.
 *
 * `TERM_PROGRAM` is the literal `vscode`, and it is one of the three variables
 * (of the editor's ten) that a terminal of our own can reproduce at all -- the
 * other seven are set by OTHER extensions through `environmentVariableCollection`,
 * which the stable API gives no way to read (§7.2). The CLI reads this one to
 * know it is inside an editor.
 *
 * The VERSION is `vscode.version`, with a difference named rather than hidden: in
 * a fork, that is the version of the VS Code it is built on, while the fork's own
 * terminals carry the fork's version (measured 2026-08-17 in Cursor 3.13.25 --
 * `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION=3.13.25`). There is no API for the
 * application's own version, and what it costs to be wrong is a version string in
 * somebody's diagnostics.
 */
const EDITOR_TERM_PROGRAM = 'vscode';

function editorIdentity(): EditorIdentity {
  return { termProgram: EDITOR_TERM_PROGRAM, termProgramVersion: vscode.version };
}

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

/**
 * How often the machine is swept, in seconds.
 *
 * A number a person can raise, because the cost of the sweep is a `claude`
 * process every interval in every open window and only they know what that is
 * worth on their machine. Out of range or not a number falls back to the
 * default with a line saying so -- a setting that silently means something else
 * is worse than one that refuses.
 */
const RECONCILE_INTERVAL_SETTING = 'gripterm.reconcile.intervalSeconds';
const MIN_RECONCILE_SECONDS = 5;
const MAX_RECONCILE_SECONDS = 3600;

function readReconcileInterval(logger: Logger): number {
  const seconds = vscode.workspace
    .getConfiguration()
    .get<number>(RECONCILE_INTERVAL_SETTING);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  if (seconds < MIN_RECONCILE_SECONDS || seconds > MAX_RECONCILE_SECONDS) {
    logger.warn('the reconcile interval is outside what this build accepts, so the default stands', {
      seconds,
      min: MIN_RECONCILE_SECONDS,
      max: MAX_RECONCILE_SECONDS,
    });
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  return seconds * MS_PER_SECOND;
}
