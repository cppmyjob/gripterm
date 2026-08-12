export {
  SUPPORTED_CLI_VERSION,
  describeCliVersion,
  parseCliVersion,
  isSupportedCliVersion,
  type CliVersionAnswer,
  type CliVersionReport,
} from './domain/agents/claude-code/cli-version';

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
  type TerminalGateway,
  type TerminalHandle,
  type TerminalSpec,
} from './domain/ports/terminal-gateway';
export {
  type OwnerIdentity,
  type OwnerLiveness,
  type OwnerPresence,
} from './domain/ports/owner-presence';
export {
  type AdoptOptions,
  type RepositoryListener,
  type TerminalRepository,
} from './domain/repositories/terminal-repository';

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
  STORAGE_DIRECTORY_MODE,
  STORAGE_SCHEMA_VERSION,
  StorageLayout,
  isJournalFileName,
  journalDay,
} from './infrastructure/store/storage-layout';
export { writeAtomic, type AtomicWriteOptions } from './infrastructure/store/atomic-file';
export { readJsonFile, writeJsonFile, type JsonRead } from './infrastructure/store/json-file';
export {
  FileTerminalRepository,
  type FileTerminalRepositoryOptions,
} from './infrastructure/store/file-terminal-repository';
export {
  FileOwnerPresence,
  HEARTBEAT_INTERVAL_MS,
  decodePresence,
  encodePresence,
  type FileOwnerPresenceOptions,
  type PresenceDecode,
  type PresenceDocument,
  type PresenceRecord,
  type SignalProbe,
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
  claudeSettingsLocations,
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
} from './domain/services/observability-watch';

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

export { terminalIdFrom } from './domain/services/terminal-target';

export {
  TerminalLifecycleService,
  type LaunchRequest,
  type TerminalLifecycleOptions,
} from './domain/services/terminal-lifecycle';

export {
  ATTENTION_SIGNALS,
  AttentionNotifier,
  DEFAULT_TOAST_SIGNALS,
  isAttentionSignal,
  FOCUS_TERMINAL_COMMAND,
  SHOW_LOGS_COMMAND,
  type AttentionNotifierOptions,
} from './domain/services/attention-notifier';

export {
  summariseTerminals,
  type StatusSummary,
} from './domain/services/terminal-summary';

export {
  CONTEXT_LIVE,
  CONTEXT_OVER,
  presentTerminal,
  type TerminalPresentation,
} from './domain/services/terminal-presentation';

export {
  SessionRegistry,
  type IngestOutcome,
  type RegistryChange,
  type RegistryListener,
  type SessionRegistryOptions,
} from './domain/services/session-registry';

export {
  TerminalStateMachine,
  type AttentionSignal,
  type IgnoredTransition,
  type MovedTransition,
  type StateTransition,
  type StayedTransition,
} from './domain/services/terminal-state-machine';
