import type { HookEvent } from '../events/terminal-event';

/**
 * The outcome of reading one HTTP body.
 *
 * Three outcomes rather than two, because "an event we do not model" and "this
 * is not a hook payload" call for opposite reactions. Claude Code emits well
 * over thirty event types and adds more between builds; subscribing to eleven
 * of them means the other twenty are ordinary, expected traffic. A payload that
 * is not a hook payload at all is a symptom -- of a wrong port, a proxy, a
 * changed contract -- and deserves a loud log.
 *
 * Declared with the PORT rather than with the parser that produces it. The type
 * moved here in M1.9 for a reason the linter enforces: `SessionRegistry` lives
 * in `domain/services/`, which may not import anything under `domain/agents/`,
 * so it cannot name the parser's module even for a type.
 */
export type HookEventParseResult =
  | { readonly status: 'parsed', readonly event: HookEvent }
  | { readonly status: 'ignored', readonly hookEventName: string }
  | { readonly status: 'malformed', readonly reason: string };

/**
 * Turns the body of a hook delivery into an event the domain understands.
 *
 * The seam exists because of decision №34: which fields a payload has, and that
 * it is JSON at all, are facts about ONE agent's CLI. The registry knows only
 * that a string arrives and one of three answers comes back, so a second agent
 * -- or a second transport for the same one -- is another implementation here
 * and no change at all to what reads the result.
 *
 * Takes the raw STRING rather than a parsed value. Whoever parses decides what
 * a malformed body is, and that decision belongs to the side that knows the
 * format.
 */
export interface HookEventReader {
  read: (raw: string) => HookEventParseResult;
}
