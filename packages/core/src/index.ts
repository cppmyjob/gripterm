export {
  SUPPORTED_CLI_VERSION,
  describeCliVersion,
  parseCliVersion,
  isSupportedCliVersion,
  type CliVersionAnswer,
  type CliVersionReport,
} from './domain/agents/claude-code/cli-version';

export {
  AGENT_LISTING_ARGS,
  parseAgentListing,
} from './domain/agents/claude-code/agent-listing';

export { claudeRenameCommand, readSessionName } from './domain/agents/claude-code/session-name';

export type { AgentListing, AgentRecord } from './domain/entities/agent-record';

export type { TranscriptIndex } from './domain/entities/transcript-index';

export { precedesBoot } from './domain/services/boot-window';

export {
  DEFAULT_RECONCILE_INTERVAL_MS,
  Reconciler,
  type ReconcileListener,
  type ReconcileReport,
  type ReconcilerOptions,
} from './domain/services/reconciler';

export {
  withGroupShare,
  type EditorLayout,
  type EditorLayoutNode,
} from './domain/services/editor-layout';

export {
  shellQuietVerdict,
  type ShellQuietPolicy,
  type ShellQuietState,
  type ShellQuietVerdict,
} from './domain/services/shell-quiet';

export {
  disposalOf,
  explainCleanup,
  planCleanup,
  planUnaskedCleanup,
  type CleanupItem,
  type CleanupPlan,
  type CleanupReason,
  type RecordDisposal,
} from './domain/services/cleanup-planner';

export {
  explainRefusal,
  planRestore,
  resumeRefusal,
  refusalAnywhere,
  type RestoreInputs,
  type RestorePlan,
  type RestoreRefusal,
  type RestoreSkip,
  type RestoreStep,
} from './domain/services/restore-planner';

export {
  DEFAULT_RESUME_TIMEOUT_MS,
  RestoreOrchestrator,
  type RestoreAttempt,
  type RestoreOrchestratorOptions,
  type RestoreOutcome,
  type RestoreReport,
} from './domain/services/restore-orchestrator';

export {
  launchReadiness,
  type LaunchInputs,
  type LaunchReadiness,
} from './domain/services/launch-readiness';

export {
  GriptermError,
  ValidationError,
  NotFoundError,
  ConflictError,
  StorageError,
  MigrationError,
  LaunchError,
  ResumeFailedError,
  ClaudeCliError,
  ListenError,
  isGriptermError,
  isErrorOfCode,
  type ErrorCode,
  type ErrorDetails,
  type GriptermErrorOptions,
  type SerializedGriptermError,
} from './domain/errors/gripterm-error';

export { type IdGenerator } from './domain/ports/id-generator';
export { type Clock } from './domain/ports/clock';
export { type Scheduler } from './domain/ports/scheduler';
export { type Disposable } from './domain/ports/disposable';
export { type Logger } from './domain/ports/logger';
export { type HookEventSink } from './domain/ports/hook-event-sink';
export {
  type AttentionAction,
  type AttentionPresenter,
  type AttentionRequest,
} from './domain/ports/attention-presenter';
export {
  type TerminalExit,
  type TerminalExitReason,
  type TerminalGateway,
  type TerminalHandle,
  type TerminalSpec,
} from './domain/ports/terminal-gateway';
export { type ScreenExit, type TerminalScreen } from './domain/ports/terminal-screen';
export {
  TERMINAL_EXIT_CAUSES,
  exitVerdict,
  type TerminalExitCause,
} from './domain/services/terminal-exit-verdict';
export {
  SCREEN_BUFFER_CEILING_CHARS,
  ScreenBuffer,
  type ScreenReplay,
} from './domain/services/screen-buffer';
export {
  EDITOR_INTERNAL_NAMES,
  terminalEnvironment,
  type EditorIdentity,
  type TerminalEnvironmentParams,
} from './domain/services/terminal-environment';
export { chooseEngine, type EngineChoice } from './domain/services/engine-selection';
export {
  FRESH_HEARTBEAT_MS,
  HEARTBEAT_INTERVAL_MS,
  type OwnerIdentity,
  type OwnerLiveness,
  type OwnerPresence,
  type OwnerSurvey,
} from './domain/ports/owner-presence';
export {
  OwnerHeartbeat,
  type OwnerHeartbeatOptions,
} from './domain/services/owner-heartbeat';
export {
  BaseProjection,
  type BaseProjectionOptions,
} from './domain/services/base-projection';
export {
  BaseWriter,
  DEFAULT_WRITE_DEBOUNCE_MS,
  type BaseWriterOptions,
} from './domain/services/base-writer';
export {
  DEFAULT_STORAGE_DIRECTORY,
  chooseStorageDir,
  type StorageDirChoice,
} from './domain/services/storage-directory';
export {
  type AdoptOptions,
  type RepositoryListener,
  type TerminalRepository,
} from './domain/repositories/terminal-repository';

export {
  observedAfter,
  observedAtStart,
  projectObserved,
  type ObservedAfterParams,
  type ProjectedEvent,
  type Projection,
  type ProjectionParams,
} from './domain/services/observed-projection';
export { type EventJournal } from './domain/ports/event-journal';
export { type HookDelivery } from './domain/entities/hook-delivery';

export {
  HookEventServer,
  bindOnce,
  listenWithRetry,
  portOf,
  type HookEventServerOptions,
} from './infrastructure/http/hook-event-server';

export { SystemClock } from './infrastructure/system-clock';
export { SystemScheduler } from './infrastructure/system-scheduler';
export { findExecutable, type ExecutableSearch } from './infrastructure/executable-lookup';
export { probeVersionOutput, type VersionProbe } from './infrastructure/cli-probe';
export { runCli, type CliRun, type CliRunOptions } from './infrastructure/cli-run';
export {
  isProcessThere,
  pidsEstablishedGone,
  sendSignalZero,
  type SignalProbe,
} from './infrastructure/process-liveness';
export {
  readTranscriptIndex,
  type DirectoryReader,
} from './infrastructure/transcript-index';
export { agentListingFrom, readAgentListing } from './infrastructure/cli-agents';
export { readClaudeSessionName } from './infrastructure/claude-session-name';
export {
  gatherRestoreInputs,
  type RestoreInputSources,
} from './infrastructure/restore-inputs';
export { SystemIdGenerator } from './infrastructure/system-id-generator';
export {
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  type FileEventJournalOptions,
  type JournalPolicy,
} from './infrastructure/store/file-event-journal';
export {
  JOURNAL_LINE_VERSION,
  decodeJournalLine,
  encodeJournalLine,
  type EncodeJournalLineParams,
  type JournalLine,
  type JournalLineDecode,
} from './infrastructure/store/journal-line';
export {
  journalDayFiles,
  lastSequenceIn,
  readJournal,
  type JournalGap,
  type JournalRead,
} from './infrastructure/store/journal-reader';
export { FileSessionSettingsStore } from './infrastructure/store/file-session-settings-store';
export {
  DEFAULT_DEBOUNCE_MS,
  RepositoryWatcher,
  nodeDirectoryWatch,
  watchedName,
  type DirectoryEvents,
  type DirectoryHandle,
  type DirectoryWatch,
  type RepositoryWatcherOptions,
} from './infrastructure/store/repository-watcher';
export {
  STORAGE_DIRECTORY_MODE,
  STORAGE_SCHEMA_VERSION,
  StorageLayout,
  isJournalFileName,
  isJournalPath,
  isTrashBatchName,
  journalDay,
  trashStamp,
} from './infrastructure/store/storage-layout';
export {
  DEFAULT_TRASH_SWEEP_INTERVAL_MS,
  SETTLED_MS,
  StorageCleaner,
  type CollectOutcome,
  type StorageCleanerOptions,
  type SweepFailure,
  type SweepOutcome,
} from './infrastructure/store/storage-cleaner';
export {
  moveAtomic,
  writeAtomic,
  type AtomicWriteOptions,
} from './infrastructure/store/atomic-file';
export { readJsonFile, writeJsonFile, type JsonRead } from './infrastructure/store/json-file';
export {
  FileTerminalRepository,
  type FileTerminalRepositoryOptions,
} from './infrastructure/store/file-terminal-repository';
export {
  FileOwnerPresence,
  decodePresence,
  encodePresence,
  type FileOwnerPresenceOptions,
  type PresenceDecode,
  type PresenceDocument,
  type PresenceRecord,
} from './infrastructure/store/file-owner-presence';
export {
  StorageMigrator,
  type StorageOrigin,
  type StoragePreparation,
} from './infrastructure/store/storage-migrator';
export {
  decodeEntry,
  encodeObserved,
  encodeRecord,
  type EntryDecode,
  type ObservedDocument,
  type ObservedProvenance,
  type RecordDocument,
} from './infrastructure/store/record-codec';
export {
  readClaudeSettings,
  type ClaudeSettingsRead,
} from './infrastructure/store/claude-settings-reader';
export { InMemoryTerminalRepository } from './infrastructure/store/in-memory-terminal-repository';
export { InMemoryOwnerPresence } from './infrastructure/store/in-memory-owner-presence';

export { requireAbsolutePath } from './domain/entities/absolute-path';
export { LAUNCH_INTENTS, type LaunchIntent } from './domain/entities/launch-intent';
export {
  LAUNCH_LOCATIONS,
  isLaunchLocation,
  type LaunchLocation,
} from './domain/entities/launch-location';
export { type AgentCommand } from './domain/entities/agent-command';
export { ListeningAddress } from './domain/entities/listening-address';
export { TerminalId } from './domain/entities/terminal-id';
export { SessionId } from './domain/entities/session-id';
export { OwnerId } from './domain/entities/owner-id';
export {
  OwnerRef,
  isEditorKind,
  isOwnerKind,
  type EditorKind,
  type OwnerKind,
  type OwnerRefParams,
} from './domain/entities/owner-ref';
export { Note } from './domain/entities/note';
export { HumanMetadata, type HumanMetadataParams } from './domain/entities/human-metadata';
export {
  PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
} from './domain/entities/permission-mode';
export { LaunchRecipe, type LaunchRecipeParams } from './domain/entities/launch-recipe';
export { CostSnapshot } from './domain/entities/cost-snapshot';
export { ContextWindowSnapshot } from './domain/entities/context-window-snapshot';
export { ObservedState, type ObservedStateParams } from './domain/entities/observed-state';
export {
  PERSISTED_TERMINAL_STATES,
  isPersistedTerminalState,
  type PersistedTerminalState,
  type TerminalState,
} from './domain/entities/terminal-state';
export {
  TERMINAL_ENGINES,
  isTerminalEngine,
  type TerminalEngine,
} from './domain/entities/terminal-engine';

export {
  asArray,
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
  asStringMap,
} from './domain/json/json-readers';
export {
  TerminalEntry,
  type CreateTerminalEntryParams,
} from './domain/entities/terminal-entry';

export {
  isHookEvent,
  launchExitedNonZero,
  processGone,
  resumeExitedNonZero,
  resumeTimedOut,
  terminalClosed,
  type CwdChangedEvent,
  type HookEvent,
  type HookEventContext,
  type LaunchExitedNonZeroEvent,
  type NotificationEvent,
  type NotificationType,
  type PermissionRequestEvent,
  type PostToolUseEvent,
  type PostToolUseFailureEvent,
  type PreToolUseEvent,
  type ProcessGoneEvent,
  type ResumeExitedNonZeroEvent,
  type ResumeTimedOutEvent,
  type SessionEndEvent,
  type SessionEndReason,
  type SessionStartEvent,
  type SessionStartSource,
  type StopEvent,
  type StopFailureEvent,
  type SyntheticEvent,
  type TerminalClosedEvent,
  type TerminalEvent,
  type UserPromptSubmitEvent,
} from './domain/events/terminal-event';

export { HookEventParser } from './domain/agents/claude-code/hook-event-parser';
export {
  type HookEventParseResult,
  type HookEventReader,
} from './domain/ports/hook-event-reader';

export {
  HOOK_EVENT_PATH_PREFIX,
  hookEventUrl,
  parseHookEventPath,
} from './domain/services/hook-endpoint';

export {
  LaunchCommandBuilder,
  type LaunchCommandParams,
} from './domain/agents/claude-code/launch-command-builder';

export {
  ClaudeCodeCommandFactory,
  type ClaudeCodeCommandFactoryOptions,
  type SessionSettingsStore,
} from './domain/agents/claude-code/command-factory';

export {
  reviewHookPolicies,
  type ClaudeSettingsSource,
  type HookPolicyContext,
  type HookPolicyFinding,
} from './domain/agents/claude-code/hook-policies';

export {
  claudeSessionsDirectory,
  claudeSettingsLocations,
  claudeTranscriptsDirectory,
  claudeUserDirectory,
  type ClaudeUserFacts,
  type SettingsLocationFacts,
  type SettingsLocations,
} from './domain/agents/claude-code/settings-locations';

export {
  SessionSettingsBuilder,
  TOKEN_ENV_VAR,
  type CommandHookConfig,
  type ForwarderScript,
  type HookConfig,
  type HookEventName,
  type HookRegistration,
  type HttpHookConfig,
  type SessionSettingsDocument,
  type SessionSettingsParams,
} from './domain/agents/claude-code/session-settings-builder';

export {
  RequestAuthenticator,
  newActivationToken,
} from './domain/services/request-authenticator';

export {
  LAUNCH_MODES,
  ProcessLaunchStrategy,
  ShellLaunchStrategy,
  type LaunchMode,
  type LaunchPlan,
  type LaunchPlanParams,
  type LaunchStrategy,
} from './domain/services/launch-strategy';

export {
  DEFAULT_SILENCE_MS,
  ObservabilityWatch,
  type ObservabilityWatchOptions,
  type SilentTerminal,
  type StrandedTerminal,
  type WatchReport,
} from './domain/services/observability-watch';

export {
  DEFAULT_NAME_POLL_MS,
  SessionNameMirror,
  type SessionNameMirrorOptions,
} from './domain/services/session-name-mirror';

export {
  TerminalTabNamer,
  type TerminalTabNamerOptions,
} from './domain/services/terminal-tab-namer';

export { shellKindFor } from './domain/services/shell-selection';

export {
  SHELL_KINDS,
  isShellKind,
  quoteForShell,
  shellCommandLine,
  type ShellKind,
} from './domain/services/shell-quoting';

export { describeDetails } from './domain/services/log-details';

export { type AgentCommandFactory } from './domain/ports/agent-command-factory';

export { defaultTerminalName } from './domain/services/terminal-naming';

export {
  identifyEditor,
  identifyWindow,
  ownerRefFor,
  type WindowFacts,
} from './domain/services/owner-identity';

export { chooseTerminal, terminalTargetOf } from './domain/services/terminal-target';
export type { SoleTerminal, TerminalChoice, TerminalTarget } from './domain/services/terminal-target';

export {
  TerminalLifecycleService,
  type DiscardOutcome,
  type LaunchRequest,
  type StartOverOutcome,
  type StartVisibility,
  type TerminalLifecycleOptions,
} from './domain/services/terminal-lifecycle';

export {
  NAME_REQUIRED,
  NOTE_REQUIRED,
  TERMINAL_COLORS,
  TerminalMetadataService,
  formatTags,
  isBlank,
  parseTags,
  type ColorChoice,
  type TerminalMetadataOptions,
} from './domain/services/terminal-metadata';

export {
  ATTENTION_SIGNALS,
  AttentionNotifier,
  DEFAULT_TOAST_SIGNALS,
  isAttentionSignal,
  FOCUS_TERMINAL_COMMAND,
  SHOW_LOGS_COMMAND,
  SHOW_RECORD_COMMAND,
  type AttentionNotifierOptions,
} from './domain/services/attention-notifier';

export {
  summariseTerminals,
  type StatusSummary,
} from './domain/services/terminal-summary';

export {
  CONTEXT_ABANDONED,
  CONTEXT_ADOPTABLE,
  CONTEXT_FOREIGN,
  CONTEXT_LIVE,
  CONTEXT_OVER,
  presentTerminal,
  type PresentationContext,
  type TerminalPresentation,
} from './domain/services/terminal-presentation';

export {
  groupTerminals,
  type TerminalGroup,
} from './domain/services/terminal-grouping';

export {
  SessionRegistry,
  type EntryChange,
  type IngestOutcome,
  type ProjectionChange,
  type RegistryChange,
  type RemovalChange,
  type RegistryListener,
  type SessionRegistryOptions,
  type UnknownConversationChange,
} from './domain/services/session-registry';

export {
  TerminalStateMachine,
  isWitnessedEnd,
  type AttentionSignal,
  type IgnoredTransition,
  type MovedTransition,
  type StateTransition,
  type StayedTransition,
} from './domain/services/terminal-state-machine';
