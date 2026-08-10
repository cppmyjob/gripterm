export {
  SUPPORTED_CLI_VERSION,
  parseCliVersion,
  isSupportedCliVersion,
} from './domain/services/cli-version.js';

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
} from './domain/errors/gripterm-error.js';

export { type IdGenerator } from './domain/ports/id-generator.js';

export { TerminalId } from './domain/entities/terminal-id.js';
export { SessionId } from './domain/entities/session-id.js';
export { OwnerId } from './domain/entities/owner-id.js';
export { OwnerRef, type OwnerKind, type EditorKind, type OwnerRefParams } from './domain/entities/owner-ref.js';
export { Note } from './domain/entities/note.js';
export { HumanMetadata, type HumanMetadataParams } from './domain/entities/human-metadata.js';
export {
  PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
} from './domain/entities/permission-mode.js';
export { LaunchRecipe, type LaunchRecipeParams } from './domain/entities/launch-recipe.js';
export { CostSnapshot } from './domain/entities/cost-snapshot.js';
export { ContextWindowSnapshot } from './domain/entities/context-window-snapshot.js';
export { ObservedState, type ObservedStateParams } from './domain/entities/observed-state.js';
export {
  type TerminalState,
  type PersistedTerminalState,
} from './domain/entities/terminal-state.js';
export {
  TerminalEntry,
  type CreateTerminalEntryParams,
} from './domain/entities/terminal-entry.js';
