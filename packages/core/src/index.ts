export {
  SUPPORTED_CLI_VERSION,
  parseCliVersion,
  isSupportedCliVersion,
} from './domain/agents/claude-code/cli-version';

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
export { type Disposable } from './domain/ports/disposable';
export { type Logger } from './domain/ports/logger';
export { type HookEventSink } from './domain/ports/hook-event-sink';
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
export { FileEventJournal } from './infrastructure/store/file-event-journal';
export { FileSessionSettingsStore } from './infrastructure/store/file-session-settings-store';
export { InMemoryTerminalRepository } from './infrastructure/store/in-memory-terminal-repository';
export { InMemoryOwnerPresence } from './infrastructure/store/in-memory-owner-presence';

export { requireAbsolutePath } from './domain/entities/absolute-path';
export { LAUNCH_INTENTS, type LaunchIntent } from './domain/entities/launch-intent';
export { type AgentCommand } from './domain/entities/agent-command';
export { ListeningAddress } from './domain/entities/listening-address';
export { TerminalId } from './domain/entities/terminal-id';
export { SessionId } from './domain/entities/session-id';
export { OwnerId } from './domain/entities/owner-id';
export { OwnerRef, type OwnerKind, type EditorKind, type OwnerRefParams } from './domain/entities/owner-ref';
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
  type TerminalState,
  type PersistedTerminalState,
} from './domain/entities/terminal-state';
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
  SHELL_KINDS,
  isShellKind,
  quoteForShell,
  shellCommandLine,
  type ShellKind,
} from './domain/services/shell-quoting';

export { describeDetails } from './domain/services/log-details';

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
