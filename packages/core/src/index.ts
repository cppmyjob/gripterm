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

export { FileSessionSettingsStore } from './infrastructure/store/file-session-settings-store';
export { InMemoryTerminalRepository } from './infrastructure/store/in-memory-terminal-repository';
export { InMemoryOwnerPresence } from './infrastructure/store/in-memory-owner-presence';

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

export {
  HookEventParser,
  type HookEventParseResult,
} from './domain/agents/claude-code/hook-event-parser';

export {
  HOOK_EVENT_PATH_PREFIX,
  hookEventUrl,
  parseHookEventPath,
} from './domain/services/hook-endpoint';

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
  TerminalStateMachine,
  type AttentionSignal,
  type IgnoredTransition,
  type MovedTransition,
  type StateTransition,
  type StayedTransition,
} from './domain/services/terminal-state-machine';
