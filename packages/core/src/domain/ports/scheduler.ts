import type { Disposable } from './disposable';

/**
 * A single delayed call, as the domain sees it.
 *
 * It exists so that a rule about TIME can be tested in the same breath as every
 * other rule. The only alternative -- a service reaching for the global
 * `setTimeout` -- makes "what happens after twenty seconds of silence" a test
 * that either waits twenty seconds or fakes the platform's clock, and neither
 * of those is a test of the rule.
 *
 * Disposing cancels the call if it has not happened, and does nothing if it has.
 */
export interface Scheduler {
  after: (ms: number, action: () => void) => Disposable;
}
