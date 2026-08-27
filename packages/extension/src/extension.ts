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
  FileLaunchTrace,
  FileLog,
  FileOwnerPresence,
  FileSessionSettingsStore,
  FileTerminalRepository,
  HOOK_EVENT_PATH_PREFIX,
  HookEventParser,
  HookEventServer,
  LogRelay,
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
  StartLedger,
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
  TrashStore,
  claudeRenameCommand,
  claudeSessionsDirectory,
  claudeSettingsLocations,
  claudeTranscriptsDirectory,
  describeCliVersion,
  endOwnTerminals,
  findExecutable,
  forgottenNotice,
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
  restoreNotice,
  reviewHookPolicies,
  shellKindFor,
  TerminalId,
} from '@gripterm/core';
import type {
  OwnerId,
  AgentCommandFactory,
  Disposable,
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
import { Asker } from './ui/ask';
import { Picker } from './ui/pick';
import { registerAdoptTerminal } from './commands/adopt-terminal';
import { registerCleanUpStorage } from './commands/clean-up-storage';
import { registerRestoreFromTrash } from './commands/restore-from-trash';
import { registerCloseTerminal } from './commands/close-terminal';
import { registerDeleteTerminal } from './commands/delete-terminal';
import { registerShowRecord } from './commands/show-record';
import { registerResumeTerminal } from './commands/resume-terminal';
import { registerStartOver } from './commands/start-over';
import { registerFocusTerminal } from './commands/focus-terminal';
import { registerMaximizeTerminals } from './commands/maximize-terminals';
import { TERMINAL_IN_FRONT_KEY, TerminalInFront } from './ui/terminal-in-front';
import { TerminalTabDecorations } from './ui/terminal-tab-decorations';
import { registerMetadataCommands } from './commands/edit-metadata';
import { registerNewTerminal } from './commands/new-terminal';
import {
  readJournalPolicy,
  readLaunchLocation,
  readIdeChannel,
  readLaunchMode,
  readStorageDir,
  readTerminalEngine,
  readToastSignals,
} from './settings';
import { terminalGatewayFor } from './terminal-gateway-factory';
import type { StripKeeper } from './adapters/vscode-terminal-gateway';
import { UnavailableAgentCommandFactory } from './adapters/unavailable-agent-command-factory';
import { VsCodeLogger } from './adapters/vscode-logger';
import { windowIdentity } from './adapters/vscode-window-identity';
import { reloadNotices } from './ui/reload-notice';
import { Announcer } from './ui/say';
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
  /**
   * The file in the store this window is also writing its log into, or `null`
   * when it could not be opened.
   *
   * Reported for the same reason it is logged: the plan's own register carried
   * "the log path is named by the product nowhere" as an open question, and a
   * file a person cannot be told the name of is a file they cannot be asked for.
   */
  readonly logFile: string | null;
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
 * send a person to different places: the first is a window with no shared store
 * to read, the second is a fault worth reporting.
 *
 * Until 2026-08-24 `skipped` was also the standing answer in a test host, which
 * made this field the one place a run could see that the restore had not
 * executed -- and the only place, because nothing else could see it either. It
 * is now read the other way round: `activation-restore.test.ts` asserts `ran`.
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
   * What is drawn on the tab of a terminal (customer's third complaint).
   *
   * Exposed for the live suite: which uri the workbench drew a tab from is
   * something only this object learns, and a test that guessed the uri would be
   * checking its own guess rather than the pairing.
   */
  readonly tabs: TerminalTabDecorations;
  /**
   * Whether the editor in front is a terminal, which is what the maximise
   * button is drawn on.
   *
   * Exposed for the live suite: a context key cannot be read back through the
   * API, so the only way to hold this promise is to ask the object that sets it.
   */
  readonly inFront: TerminalInFront;
  /**
   * The group the terminals live in, when they live in one -- `null` under the
   * `own` engine and under any launch location but `group`.
   *
   * Exposed for the live suite: taking away the empty strip a restart leaves
   * behind is a rule about a window that has just woken, and the only way to
   * put a suite in front of it is to build the shape by hand and ask.
   */
  readonly editorStrip: StripKeeper | null;
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
  /**
   * What this window has told the person, latest last.
   *
   * Exposed because a notification cannot be read back through the editor API
   * and cannot be intercepted from a suite either (measured 2026-08-18 --
   * `ui/say.ts`). Several promises of this build are sentences: the fallback
   * from `own` to the editor engine (O5), the settings that need a reload
   * (M3.13), the terminal nobody is tracking. Without this they could only be
   * checked by a person watching for a toast.
   */
  readonly said: readonly string[];
  /**
   * The modal questions, and the seam that answers them (M3.14).
   *
   * Exposed for the reason `said` is, and one more: a modal cannot be clicked
   * by a run at all, so a promise standing behind one -- ending a live
   * conversation asks first -- could otherwise be held by nothing.
   */
  readonly asker: Asker;
  /**
   * The lists this window offers, and the seam that answers them (Ш15).
   *
   * Exposed for the reason `asker` is: a quick pick cannot be chosen from by a
   * run, so "a record comes back OUT OF THE INTERFACE" could otherwise be held
   * by nothing but a unit test of the store beneath it.
   */
  readonly picker: Picker;
  /** The trash and the way back out of it, or `null` in a window with no shared base. */
  readonly trash: TrashStore | null;
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
  const clock = new SystemClock();
  /*
   * Two destinations behind one port, and the second one does not exist yet
   * (Ш3).
   *
   * The editor's panel is where a person looks while the window is in front of
   * them. It is no use at all for the case this build actually has to answer:
   * somebody else's window went wrong, they closed it, and what reaches me is
   * whatever they thought to photograph. So the same lines are written into the
   * store as well -- `logs/<ownerId>.log` -- and the request becomes one
   * sentence that never changes: send me the `.gripterm` folder.
   *
   * The relay is here rather than a second logger passed around, because WHERE
   * the store is has not been decided on this line: the setting is read a
   * hundred lines below, and everything said in between is about how that
   * decision went. Those lines are held and replayed with the moment each one
   * happened.
   */
  const logger = new LogRelay({ first: new VsCodeLogger(output), clock });
  // Everything this window tells a person goes through here, so that "it said so"
  // is a thing a run can check rather than a thing a screenshot shows (M3.13).
  const announcer = new Announcer(logger);
  // The modal questions, in one place for the same reason: a run cannot click
  // a dialog, and a dialog nobody can answer is a run that hangs (M3.14).
  const asker = new Asker();
  // Everything this window ASKS a person to choose between goes through here,
  // for the reason `Asker` gives about everything it asks them to confirm.
  const picker = new Picker();

  /*
   * When this window began waking up, so that it can say how long it took.
   *
   * The customer, 2026-08-22: "само окно Claude Code Terminals загружает данные
   * после открытия приложения очень долго — до минуты". A complaint about time
   * cannot be answered by a build that never says what it spent, and the two
   * lines this stamps -- the list going on screen, and activation finishing --
   * are the two moments a person is actually waiting for.
   */
  const wokeAtMs = clock.now().getTime();
  /*
   * And WHAT THAT TIME WENT ON (Ш22).
   *
   * Ш11 removed four named causes and closed less than a second of the 8 293 ms
   * the owner's own window took on 2026-08-23. The seven that are left are
   * explained by nothing, and they cannot be explained from here: the store they
   * happen over is theirs, and this build does not read it. So the instrument is
   * HANDED OVER rather than applied -- a start writes down what it was made of,
   * into the log this window already keeps in the store, and the numbers of that
   * machine are read on that machine.
   *
   * NOT a third counter. It takes the instant above and the clock beside it, and
   * the two lines below go on printing exactly the `tookMs` they printed before;
   * what is new is the division of that number, not the number.
   *
   * Every part is threaded in by wrapping a call that was already here, so the
   * order of activation is untouched -- with one exception, named as one: the
   * plan of the restore and its execution are timed separately inside
   * `bringTerminalsBack`, which is why that function now takes the ledger.
   */
  const ledger = new StartLedger({ clock, wokeAtMs });
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

  /*
   * The state of an agent on the tab of its terminal (customer's third
   * complaint, 2026-08-21).
   *
   * Made before the gateway because the gateway is what feeds it: only the
   * thing that CREATES a terminal knows the tab about to appear is ours, and
   * the pairing has to be in place before the workbench draws it.
   */
  const tabs = new TerminalTabDecorations({ registry, logger });
  context.subscriptions.push(tabs);

  /*
   * Whether a terminal is the editor in front (customer's report, 2026-08-22).
   *
   * A context key of ours, set from here and nowhere else, and the reason it
   * exists is in `TerminalInFront`: the platform key it replaces was answered
   * by one editor and not by the other, which took the maximise button off the
   * terminal's tab AND out of the command palette in the same stroke.
   */
  const inFront = new TerminalInFront({
    announce: (terminal) => {
      void vscode.commands.executeCommand('setContext', TERMINAL_IN_FRONT_KEY, terminal);
    },
    logger,
  });
  context.subscriptions.push(inFront);

  const location = readLaunchLocation(logger);
  // Read here rather than where it used to be read, further down: the engine is
  // chosen from BOTH settings, because a terminal of our own has no shell to type
  // a launch line into (`chooseEngine`).
  const mode = readLaunchMode(logger);
  /*
   * A holder rather than a bare `let`: the strip is handed over from inside a
   * callback, and a narrowing that cannot see the callback run would read the
   * variable as `null` for the rest of this function.
   */
  const held: { strip: StripKeeper | null } = { strip: null };
  // Timed because it is where the native addon is loaded from disk, when the
  // engine is ours: a `require` of a compiled binding is the one thing in this
  // stretch of composition that touches a file (Ш22).
  const gateway = ledger.time('buildingTheGateway', () => terminalGatewayFor({
    keepTheStrip: (keeper) => {
      held.strip = keeper;
    },
    setting: readTerminalEngine(logger),
    mode,
    location,
    ideChannel: readIdeChannel(),
    extensionPath: context.extensionPath,
    editor: editorIdentity(),
    logger,
    audience: stage,
    // O5: a fallback nobody hears is a setting that reads `own` over a terminal
    // that is not one. The window says it once, here, and never again for an
    // engine that was honoured.
    announce: (message) => { announcer.say('warning', message); },
    tabOpened: (terminalId, terminal) => { tabs.expect(terminalId, terminal as vscode.Terminal); },
  }));
  // Still a subscription as well, and deliberately: `deactivate` covers the
  // ordinary way out, this covers the extension being disabled under a window
  // that stays open. Both ends are idempotent -- a gateway that has let go of
  // its terminals has none to let go of twice.
  context.subscriptions.push({ dispose: () => { gateway.dispose(); } });
  const endOwnProcesses = (): WindowShutdownReport =>
    endOwnTerminals({ gateway, entries: registry.own(), endProcess: sendKillSignal, logger });
  farewell = endOwnProcesses;

  const storageChoice = readStorageDir(logger, context);
  // Said, not merely logged: a window quietly looking at a store that is not the
  // person's shows an empty list and no reason for it, which is the shape of
  // every "my terminals are gone" report.
  if (storageChoice.announce !== null) {
    announcer.say('warning', storageChoice.announce);
  }
  const storage = new StorageLayout(storageChoice.path);
  const store = await ledger.measure(
    'preparingTheStore',
    async () => await prepareStorage(storage, logger)
  );
  // After the migrator, not before it: the log is a directory in the base, and
  // making one there while the base is still being decided about would hand the
  // migrator a store that is not empty when it asks.
  const logFile = keepALogInTheStore(storage, identity.ownerId, logger);
  /*
   * The part that reads EVERY record on the machine, and the first candidate for
   * the owner's missing seconds (Ш22): `projection.refresh()` inside it is a
   * whole pass over the base, so this is the number that ought to move with the
   * size of a store.
   */
  const shared = await ledger.measure(
    'readingTheStore',
    async () => await shareTheBase({ context, storage, store, registry, identity, clock, logger })
  );
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
   * The way back out of `trash/` (Ш15).
   *
   * Beside the cleaner rather than inside it, and the split is the one this
   * build already draws between reading a store and sweeping one: `StorageCleaner`
   * is the object that MOVES records out on a rule and empties the trash on a
   * clock, and nothing that only ever gives a record back belongs behind the same
   * door. Only where there is a shared base, for the reason the cleaner is: a
   * window reading nothing has no trash to look in.
   */
  const trash = shared === null ? null : new TrashStore({ layout: storage, logger });
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
  const address = await ledger.measure(
    'openingThePort',
    async () => await listen({ token, registry, logger, journal: events })
  );
  const cliPath = await ledger.measure('findingTheCli', async () => await findCli(logger));
  /*
   * Which BUILD of `claude` this is -- started here and awaited at the bottom
   * (Ш11).
   *
   * It is a process spawn, and nothing between here and the list needs its
   * answer: `launchReadiness` takes the path. Before this it was awaited on the
   * spot, so the wait bought a string for one log line.
   *
   * ITS SIZE, MEASURED RATHER THAN QUOTED, and it is smaller than the comment
   * on `VERSION_TIMEOUT_MS` would suggest: four runs on this machine on
   * 2026-08-26 took 91, 91, 87 and 96 ms, against the 264 ms measured on
   * 2026-08-11. So this move is worth about a tenth of a second of a person's
   * wait -- real, and the smallest of the four repairs of Ш11.
   *
   * Not fire-and-forget: `readiness.cliVersion` is part of what activation
   * establishes and the integration suite reads it, so the promise is awaited
   * once, after the list is up. Its own failures are already values rather than
   * throws -- see `probeVersionOutput` -- so there is no rejection here to lose.
   */
  const cliVersion = versionOfCli(cliPath, logger);
  const forwarder = await ledger.measure(
    'findingTheForwarder',
    async () => await findForwarder(context, logger)
  );

  const readiness = launchReadiness({ cliName: CLAUDE_CLI, cliPath, address });

  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway,
    commands: commandFactoryFor(readiness, token, forwarder, storage),
    strategy: strategyFor(mode),
    ids,
    clock,
    owner: ownerRefFor(identity),
    logger,
    // Beside the record and not only in the Output panel: the panel dies with
    // the window, and the question a person asks the next morning is about the
    // window that is gone (owner, 2026-08-23 -- see `LaunchTrace`).
    trace: new FileLaunchTrace({ layout: storage, clock, logger }),
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
   *
   * **It is the STORE's signal and not this window's own** (Ш11). Until
   * 2026-08-26 it hung off `shared.repository.watch`, which fires on what THIS
   * window writes -- so it was woken by the records the restore was laying down,
   * inside the restore, with no previous pass to hold it back, and it was never
   * woken by another window at all. Measured, at eight records:
   * `spikes/start-budget/activation-spawns.mjs --wired local` asks the CLI once
   * inside the restore, `--wired store` asks nought.
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
      // First-hand, and it outranks the pid: the gateway either has a terminal
      // for that record or it does not. See `_lostItsProcess`, where the
      // customer's log of 2026-08-22 is written down.
      holdsTerminal: (terminalId) => gateway.handleFor(terminalId) !== undefined,
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
      shared.watchPresence(() => {
        void reconciler.sweepIfStale();
      })
    );
  }

  const tree = ledger.time('buildingTheList', () => new TerminalTreeDataProvider({
    registry,
    reconciler,
    // The folders of THIS window, which is what puts its own project at the top
    // of a list that shows every project on the machine (П4).
    windowFolders: identity.workspaceFolders,
    logger,
  }));
  context.subscriptions.push(tree);
  // Held, not just disposed of: `gripterm.showRecord` reveals a row through it,
  // and a data provider alone cannot select anything (M2.13).
  const view = ledger.time('buildingTheList', () => vscode.window.createTreeView(TERMINALS_VIEW_ID, {
    treeDataProvider: tree,
    // The same object: a row is dragged out of the list the provider drew, and
    // where it lands is decided against that same list (owner, 2026-08-21).
    dragAndDropController: tree,
  }));
  context.subscriptions.push(view);
  /*
   * The groups a restart brought back with nothing in them (owner, 2026-08-22:
   * "при переоткрытии остаётся пустая панель"; and again 2026-08-23, with three
   * of them: "повторилось также появились пустые группы").
   *
   * Here, and this early, because what the person is looking at is the point:
   * measured in Cursor on 2026-08-22 with a real reload, the empty group came
   * back holding 248 of the 743 pixels the editor area has, and stood there
   * until this ran. Everything below is store work that nobody can see.
   *
   * Not awaited, and it must not be: it waits on the workbench to finish
   * restoring the grid, which is up to three seconds, and nothing below depends
   * on the answer. Whoever asks for a strip meanwhile cancels it from inside.
   */
  if (held.strip === null) {
    // The EIGHTH way this one act does nothing, and the only one outside the
    // strip itself. Said for the reason all the others now are (Ш3): a window
    // that swept nothing and a window that never swept must not read alike in a
    // log, and this is the one that never swept.
    logger.info('the empty groups were not looked for: this window keeps no group of its own', {
      engine: gateway.engine,
      location,
    });
  } else {
    void held.strip.takeAwayEmptyGroups().catch((cause: unknown) => {
      logger.warn('the empty groups could not be looked for', { cause });
    });
  }

  logger.info('the list of terminals is on screen', {
    /*
     * Everything before this: the store, the base read whole, the port, and
     * finding `claude`. What comes after it -- the restore, the first sweep --
     * changes what the rows SAY, and is timed by the line at the end.
     *
     * `tookMs` is the same number and the same arithmetic it has been since
     * 2026-08-22; `phases` and `remainderMs` are that number divided up (Ш22).
     * The three obey `sum(phases) + remainderMs === tookMs`, so a part left out
     * shows as a bigger leftover rather than as a smaller whole. The leftover is
     * the composition itself -- objects built, settings read, commands
     * registered -- and it is named rather than shared out among the parts.
     */
    ...ledger.breakdown(),
    rows: registry.list().length,
  });
  // The version probe, collected now that nobody is waiting on the list for it.
  const cli = {
    path: cliPath,
    version: await ledger.measure('waitingForTheCliVersion', async () => await cliVersion),
  };
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
        announcer.say('warning', sentenceFor(report));
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
      // Out loud, because the row cannot say it: a conversation that did not
      // come back leaves a perfectly healthy-looking agent behind (owner,
      // 2026-08-23).
      announce: (message) => { announcer.say('warning', message); },
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
          /*
           * The two questions of the survey that leave this machine's own store
           * are timed under their own names (Ш22), which is why they are wrapped
           * HERE rather than inside `gatherRestoreInputs`: the gatherer takes
           * them as callbacks, so the composition root can name them without the
           * domain learning what a stopwatch is.
           *
           * They run INSIDE `readingTheMachine`, and the ledger credits the
           * innermost part only -- so `readingTheMachine` reports the survey
           * minus these two, and the three numbers never overlap.
           */
          readTranscripts: async () =>
            await ledger.measure('theTranscriptIndex', async () =>
              await readTranscriptIndex(
                claudeTranscriptsDirectory({
                  platform: process.platform,
                  home: homedir(),
                  configDir: process.env.CLAUDE_CONFIG_DIR,
                })
              )),
          readAgents: async () =>
            await ledger.measure('theAgentListing', async () =>
              readiness.kind === 'refused'
                ? { kind: 'unavailable', reason: readiness.reason }
                : await readAgentListing(readiness.cliPath, AGENT_LISTING_TIMEOUT_MS)),
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
  /*
   * The chevron on the group holding the terminals (customer, 2026-08-21).
   * Registered whatever the engine is: the buttons that reach it are contributed
   * against a terminal EDITOR, which is a thing only the editor engine makes,
   * and the palette entries do no harm anywhere else.
   */
  context.subscriptions.push(
    registerMaximizeTerminals({
      standOnTheStrip: async () => (await held.strip?.standOnTheStrip()) ?? false,
      logger,
    })
  );
  context.subscriptions.push(registerCloseTerminal(lifecycle, registry, asker, logger));
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
    registerRestoreFromTrash({
      // The store alone: bringing a record back is a decision about the trash
      // and about nothing else in the world, which is exactly why it needs no
      // predicate, no survey and no window liveness the way the cleanup does.
      trash,
      picker,
      announcer,
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
  context.subscriptions.push(
    ...registerMetadataCommands(metadata, registry, logger, () =>
      // The terminal on this window's own screen, for the one picker that puts
      // it first (owner's decision 2026-08-20). Read at the moment the command
      // runs rather than held: what is on screen is exactly the thing that
      // changes between two invocations. `null` under the editor's engine, which
      // has no screen of ours -- and `tryFromString` rather than `fromString`,
      // because a stage that ever holds something unparseable must not turn a
      // note into a thrown error.
      stage.activeTerminal === null ? null : TerminalId.tryFromString(stage.activeTerminal)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gripterm.showLogs', () => {
      output.show(true);
    })
  );
  // The configuration keys this build listens to, and it listens in order to say
  // that listening is not enough. Everything downstream of them -- this window's
  // presence file, the watcher, the journal, the `settings.json` the running
  // CLIs have already read, the gateway that makes terminals -- is built once at
  // activation, so a change that silently moved half of it would leave this
  // window part in the new world and part in the old. The names and the
  // sentences are `reloadNotices`, where they can be read without a host.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      for (const notice of reloadNotices(event)) {
        announcer.say('info', notice);
      }
    })
  );

  // BEFORE the machine is read, not merely before the restore (M3.5). The world
  // below is gathered once and every gate of the restore is answered from it, so
  // a process ended after that gathering would still be counted as running --
  // and the records of the window that left it behind would be refused while
  // nothing was running them at all.
  await ledger.measure('endingTheirProcesses', async () => {
    await endTheirProcesses({ context, reconciler, logger });
  });

  // One reading for both of the decisions below -- see `surveyTheMachine`.
  // Timed as `readingTheMachine`, which is the survey MINUS the two questions it
  // asks through callbacks -- see `gather` above (Ш22).
  const world = await ledger.measure(
    'readingTheMachine',
    async () => await surveyTheMachine({ gather, logger })
  );
  const restore = await bringTerminalsBack({
    world,
    orchestrator,
    readiness,
    logger,
    ledger,
    // Out loud, and once (owner's decision 2026-08-21). Before this, a window
    // that brought nothing back wrote the reason to the log in the same second
    // and said nothing at all -- and from the chair that reads as terminals
    // silently vanishing. What is said and what is kept quiet is decided in
    // `restoreNotice`, in the domain, because it is a decision.
    announce: (message) => { announcer.say('warning', message); },
  });
  // After the restore and against the SAME reading: the two plans are disjoint
  // by construction (M2.15), and a record this window has just adopted is one
  // whose owner is now alive, which no cleanup touches.
  await ledger.measure('forgettingClosedTerminals', async () => {
    await forgetClosedTerminals({
      world,
      cleaner,
      logger,
      // Out loud (Ш15). This is the ONE way into the trash that takes a record
      // with nobody asked, and until now the whole of its trace was two lines in
      // a log -- so from the chair it read as rows quietly disappearing. What is
      // said, and when nothing is said at all, is decided by `forgottenNotice`,
      // in the domain, because it is a decision.
      announce: (message) => { announcer.say('info', message); },
    });
  });

  // After the restore, not before: a sweep that ran first would look at records
  // this window is about to adopt and start, and the first thing it would find
  // is that their processes are gone -- which they are, for another second.
  if (reconciler !== null) {
    // The pass includes one `claude agents --json` of its own, and it is counted
    // here rather than under `theAgentListing` (Ш22): that name is the survey's
    // question, asked once, and folding a second call into it would make one
    // printed number the sum of two different acts.
    await ledger.measure('theFirstSweep', async () => {
      await reconciler.sweep();
    });
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
   *
   * **Never in a test host, and the reason has changed under it -- so it is
   * restated rather than left standing.** It was written when the runner left a
   * test host pointed at the person's own store; that is no longer true (Ш1),
   * and `surveyTheMachine`'s twin of this refusal was removed on 2026-08-24
   * because a store the run owns bounds everything done inside it. This one is
   * not bounded the same way: `trash/` is the only way back from `remove()`,
   * from the presence sweep and from `forgetClosedTerminals`, and `collect()` is
   * the single operation in this build that empties it for good. A store of the
   * run's own makes those batches the run's own, but it does not make deleting
   * them undoable, and this change measured nothing about that.
   *
   * **What would take it off**, so that it is a decision with a condition rather
   * than a fixture: a run that seeds a batch of its own, sweeps, and asserts what
   * went and what stayed -- the way the integration suite already drives the
   * survey and the reconciliation. Until then a test that wants a pass over the
   * trash asks for one.
   */
  if (cleaner !== null) {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      logger.info('the trash was left as it is, because a test host must not remove batches somebody may still need');
    } else {
      void cleaner.collect().catch((cause: unknown) => {
        logger.warn('the trash could not be swept at activation, so it may hold more than it should', {
          cause,
        });
      });
      cleaner.start();
    }
  }

  // `appName` is logged beside the kind we made of it, unconditionally. An
  // editor we do not recognise then names itself in the one place a person can
  // send us -- which is how the list in `identifyEditor` grows from evidence
  // rather than from guesses.
  logger.info('Gripterm activated', {
    // The whole of the start, and what it was made of (Ш22). `tookMs` is
    // unchanged; `phases` holds every part in the order it happened, and
    // `remainderMs` is what no part covers -- named, never shared out.
    ...ledger.breakdown(),
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
    tabs,
    inFront,
    editorStrip: held.strip,
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
    get said(): readonly string[] {
      return announcer.said;
    },
    asker,
    /**
     * The lists, and the seam that answers them (Ш15).
     *
     * Exposed for the reason `asker` is: a quick pick cannot be clicked by a run
     * at all, so the promise standing behind one -- a record brought back out of
     * the trash FROM THE INTERFACE rather than from a file manager -- could
     * otherwise be held by nothing but a unit test of the store underneath it.
     */
    picker,
    /**
     * The trash itself, or `null` in a window with no shared base.
     *
     * Exposed so that a suite can read what a person would be offered without
     * driving the list, and can check the store after a return.
     */
    trash,
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
      logFile,
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
 * silence. Two of them are `surveyTheMachine`'s -- a window with no shared base
 * to read, and a machine that could not be read -- and the third is its own:
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
  /**
   * Where the two halves of this are timed (Ш22).
   *
   * Handed in rather than the whole call being wrapped from outside, because
   * the two halves answer different questions: deciding WHAT to bring back is
   * arithmetic over a value already in memory, and bringing it back starts
   * processes. One number over both would hide whichever is the expensive one.
   */
  readonly ledger: StartLedger;
  /** How the person is told which terminals did not come back. */
  readonly announce: (message: string) => void;
}): Promise<RestoreSummary> {
  const { world, readiness, orchestrator, logger, ledger, announce } = parts;
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
    const plan = ledger.time('planningTheRestore', () => planRestore(world.inputs));
    const report = await ledger.measure(
      'bringingTerminalsBack',
      async () => await orchestrator.run(plan)
    );
    const notice = restoreNotice(report.skipped);
    if (notice !== null) {
      announce(notice);
    }
    return {
      kind: 'ran',
      planned: plan.steps.length,
      started: report.started,
      refused: report.skipped.length,
    };
  } catch (cause: unknown) {
    logger.error('this window could not bring its terminals back', { cause });
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
 * **Refused in a test host -- and this is now the ONLY refusal of that shape
 * left at activation, which is why it says why it stays.** `surveyTheMachine`
 * had one and lost it on 2026-08-24: everything downstream of reading the
 * machine happens INSIDE the store -- a record is adopted, a terminal is
 * started, a closed record is moved to `trash/` -- so a run that owns its store
 * bounds all of it, and the extension refuses to open a store it was not pointed
 * at (`readStorageDir`). None of that reasoning reaches this line. Ending a
 * process is not an operation on the store: it takes a pid a record happens to
 * carry and kills whatever holds that number on the machine the run is on --
 * which may be a conversation somebody is in the middle of, and which no
 * directory of ours makes reversible. `gripterm.storage.path` cannot bound it,
 * so the mode is still the honest question here.
 *
 * The integration suite drives the pass explicitly instead, over a record and a
 * process it made itself (`orphan-processes.test.ts`).
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

/**
 * Reads the machine, in every window -- including a test host.
 *
 * **A test host was refused here until 2026-08-24, and the refusal was the wrong
 * shape of the right rule.** What it was guarding against is real: a suite that
 * ran would adopt this machine's records, start `claude --resume` on the
 * person's own conversations and move their closed ones into the trash, as a
 * side effect of running tests. But it guarded by asking WHO IS ASKING, and the
 * danger is WHICH STORE IS OPEN -- so the price of it was that the restore
 * executed in no run anywhere, and no stand could show that a window brings
 * anything back at all. The plan calls that being blind (Ш2); the owner's own
 * S01 -- "I opened the project and yesterday's agents came back" -- had nothing
 * behind it but the fact that it had never been seen to fail.
 *
 * **What replaced it, and it is the reason this may be removed at all:**
 * `readStorageDir` THROWS in a test host whose `gripterm.storage.path` is not
 * set, so a window pointed at `~/.gripterm` never reaches this line -- it never
 * finishes activating. That refusal is keyed on the thing that decides the harm,
 * it acts before anything else does, and it cannot be satisfied by accident. The
 * two are not interchangeable and the removal of one required the other; see the
 * doc comment there for why it throws rather than reports.
 *
 * **`endTheirProcesses` keeps its own test-host refusal, and the difference is
 * not squeamishness.** Everything this function leads to is confined to the
 * store: adoption, a start, a move into `trash/`. A store that belongs to the
 * run therefore bounds all of it, and the trash bounds the rest. Ending a
 * process is not in the store and not in any store -- it reaches out of the
 * directory the run owns and kills whatever a pid names on the machine the run
 * happens to be on, and no directory of ours makes that reversible.
 */
async function surveyTheMachine(parts: {
  readonly gather: (() => Promise<RestoreInputs>) | null;
  readonly logger: Logger;
}): Promise<MachineSurvey> {
  if (parts.gather === null) {
    return { kind: 'unread', reason: 'this window is not reading the shared store' };
  }
  try {
    return { kind: 'read', inputs: await parts.gather() };
  } catch (cause: unknown) {
    parts.logger.error('this window could not read the machine, so it changed nothing about it', {
      cause,
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
  readonly announce: (message: string) => void;
}): Promise<void> {
  const { world, cleaner, logger, announce } = parts;
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
    const notice = forgottenNotice({
      moved: outcome.moved.length,
      failed: outcome.failed.length,
      batch: outcome.batch,
    });
    if (notice !== null) {
      announce(notice);
    }
  } catch (cause: unknown) {
    logger.warn('the records of closed terminals could not be moved to the trash', {
      cause,
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
  /**
   * A word when `owners/` changes -- another window announcing itself, or
   * retiring.
   *
   * The store's watcher and not this window's repository, which is the whole of
   * Ш11's cause 2: the repository's own signal fires on what WE write, so the
   * sweep hung off it was woken by the restore's own records, in the middle of
   * the restore, and never by the event it was subscribed for.
   */
  readonly watchPresence: (listener: () => void) => Disposable;
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
      cause,
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
  return {
    repository,
    presence: owner,
    watchPresence: (listener) => watcher.watchPresence(listener),
  };
}

/**
 * Points this window's log at a file in the store, and says where it went (Ш3).
 *
 * **The whole of what this buys.** Before it, the only evidence of somebody
 * else's window misbehaving was a screenshot: a report command has to be run IN
 * the broken window, and a person closes the window before they write to me. A
 * file beside the records it is about works backwards -- on the sitting that has
 * already gone wrong -- and the request for it is one sentence for ever.
 *
 * **A failure here does not stop activation, and does not stay quiet either.**
 * The window still works with no log in the store; what it loses is the ability
 * to explain itself later, which is worth a warning and not a refusal. The name
 * of the file is said out loud on the way through, because the plan's register
 * carried "the product names the log path nowhere" as an open question, and a
 * file nobody can be told the name of is a file nobody can be asked for.
 */
function keepALogInTheStore(layout: StorageLayout, ownerId: OwnerId, relay: LogRelay): string | null {
  let path: string;
  try {
    path = layout.logFile(ownerId);
  } catch (cause: unknown) {
    // `logFile` refuses an id that could not be a file name -- the same check
    // the presence file gets, for the same reason.
    relay.warn('this window`s id could not name a log file, so its log stays in this panel only', {
      ownerId: ownerId.value,
      cause,
    });
    return null;
  }
  try {
    relay.alsoTo(new FileLog({ path }));
  } catch (cause: unknown) {
    relay.warn('the store would not take a log file, so this window`s log stays in this panel only', {
      path,
      cause,
    });
    return null;
  }
  relay.info('this window is also writing its log into the store', { path });
  return path;
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

/**
 * Where `claude` is: a walk of the PATH, and no process started.
 *
 * Split from the version probe on 2026-08-26 (Ш11), because the two cost
 * entirely different things and only one of them is needed before a person can
 * see their list.
 */
async function findCli(logger: Logger): Promise<string | null> {
  const path = await findExecutable(CLAUDE_CLI, systemSearch());
  if (path === null) {
    // Not an error: a person may simply not have installed it. The refusal a
    // person actually reads is raised when they ask for a terminal.
    logger.warn('Claude Code was not found on the PATH this window inherited', {
      looked: CLAUDE_CLI,
    });
  }
  return path;
}

/** Which build it is -- established by running it, never by reading a file. */
async function versionOfCli(path: string | null, logger: Logger): Promise<string | null> {
  if (path === null) {
    return null;
  }
  const report = describeCliVersion(await probeVersionOutput(path, VERSION_TIMEOUT_MS));
  const details = { path, message: report.message };
  if (report.level === 'warn') {
    logger.warn('the installed Claude Code is not the build this was measured against', details);
  } else {
    logger.info('Claude Code is the build this was measured against', details);
  }
  return report.version;
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
