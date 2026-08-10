/**
 * The error hierarchy. Shape carried over from the planner project: a base
 * class with a stable `code`, structured `details`, a `toJSON()` and an
 * explicit prototype fix in the constructor.
 *
 * One lesson carried over verbatim: DO NOT wrap one of these in another. Double
 * wrapping produces messages of the form "error: error", which say nothing and
 * bury the sentence that did. Where the origin matters, pass it as `cause` --
 * the chain survives and the message stays one sentence.
 */

/**
 * The durable discriminator. It is `code`, not the class, that crosses a file,
 * a log line or a process boundary, so every branch that reacts to a failure
 * reads this rather than testing `instanceof`.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STORAGE_ERROR'
  | 'MIGRATION_ERROR'
  | 'LAUNCH_ERROR'
  | 'RESUME_FAILED'
  | 'CLAUDE_CLI_ERROR';

/** Structured context. Never a formatted sentence -- that is what `message` is. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface SerializedGriptermError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: ErrorDetails;
}

export interface GriptermErrorOptions {
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
}

export abstract class GriptermError extends Error {
  public readonly code: ErrorCode;
  public readonly details: ErrorDetails;

  /**
   * `name` is passed in rather than read from `new.target.name`. The extension
   * ships through esbuild with `minify` on for production builds, where class
   * names are mangled; a literal survives that, a reflected name does not.
   */
  protected constructor(
    name: string,
    code: ErrorCode,
    message: string,
    options: GriptermErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = name;
    this.code = code;
    this.details = Object.freeze({ ...options.details });

    // Restores the prototype chain, which `extends Error` loses whenever the
    // output is downlevelled. Written against `new.target` so that every
    // subclass is covered by this one line.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): SerializedGriptermError {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Something arrived in a shape the domain refuses to represent. */
export class ValidationError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('ValidationError', 'VALIDATION_ERROR', message, options);
  }
}

/** A record was addressed by an id nothing answers to. */
export class NotFoundError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('NotFoundError', 'NOT_FOUND', message, options);
  }
}

/**
 * Two writers reached the same record. In this design that is one named
 * situation and not a general hazard: adoption of a dead owner's record, where
 * the loser of the compare-and-swap on `revision` re-reads and retries.
 */
export class ConflictError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('ConflictError', 'CONFLICT', message, options);
  }
}

/** The store could not be read or written. */
export class StorageError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('StorageError', 'STORAGE_ERROR', message, options);
  }
}

/** A stored record is of a schema this build cannot bring forward. */
export class MigrationError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('MigrationError', 'MIGRATION_ERROR', message, options);
  }
}

/** Starting a new terminal failed. */
export class LaunchError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('LaunchError', 'LAUNCH_ERROR', message, options);
  }
}

/** Restoring an existing session failed. Distinct from a failed launch: the two end in different states. */
export class ResumeFailedError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('ResumeFailedError', 'RESUME_FAILED', message, options);
  }
}

/** The Claude Code CLI itself refused, or answered in a way we cannot read. */
export class ClaudeCliError extends GriptermError {
  constructor(message: string, options?: GriptermErrorOptions) {
    super('ClaudeCliError', 'CLAUDE_CLI_ERROR', message, options);
  }
}

export function isGriptermError(value: unknown): value is GriptermError {
  return value instanceof GriptermError;
}

/**
 * Narrows by `code` rather than by class. Preferred at every boundary the error
 * may have crossed, and the only form that keeps working if an error is ever
 * rebuilt from its serialized shape.
 */
export function isErrorOfCode<TCode extends ErrorCode>(
  value: unknown,
  code: TCode
): value is GriptermError & { readonly code: TCode } {
  return isGriptermError(value) && value.code === code;
}
