import type { ErrorDetails } from '../errors/gripterm-error';

/**
 * Where this extension says what happened.
 *
 * Deliberately absent from M1.5, which had no consumer for it; it appears here
 * because the receiver has three failures that are invisible by construction --
 * an event turned away, a journal that refused, a sink that threw -- and each of
 * them happens on a path nobody is watching. A silent one is the same defect
 * class as an unobserved terminal.
 *
 * `details` is structured and never a formatted sentence, for the reason the
 * error hierarchy gives: the sentence is `message`, and a log line that has
 * baked its context into prose cannot be searched by it.
 */
export interface Logger {
  info: (message: string, details?: ErrorDetails) => void;
  warn: (message: string, details?: ErrorDetails) => void;
  error: (message: string, details?: ErrorDetails) => void;
}

/** The three the `Logger` port offers, as a value a line can carry. */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * One line, with the moment it happened attached.
 *
 * The moment is part of the line rather than taken by whoever writes it down,
 * and that is the whole reason this type exists beside `Logger`. A line can be
 * held and written later -- the store a log goes into is not known until a
 * hundred lines into activation -- and a held line stamped at the moment it was
 * finally written is a log that cannot be lined up with a person's account of
 * what they saw.
 */
export interface LogLine {
  readonly at: Date;
  readonly level: LogLevel;
  readonly message: string;
  readonly details: ErrorDetails | undefined;
}

/**
 * Somewhere a line is written down, as opposed to somewhere it is said.
 *
 * Separate from `Logger` because the two have different failure modes and
 * different callers. A `Logger` is what the whole build talks to and it never
 * fails; a sink touches a medium, so it can fail, and something above it has to
 * decide what that means. `LogRelay` is that something.
 */
export interface LogSink {
  readonly write: (line: LogLine) => void;
}
