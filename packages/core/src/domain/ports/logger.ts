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
