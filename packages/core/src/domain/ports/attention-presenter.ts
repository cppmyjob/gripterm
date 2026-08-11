import type { AttentionSignal } from '../services/terminal-state-machine';
import type { TerminalId } from '../entities/terminal-id';

/** A button on the notification. Nothing is offered that the host cannot carry out. */
export interface AttentionAction {
  readonly title: string;
  readonly command: string;
  readonly arguments: readonly string[];
}

export interface AttentionRequest {
  readonly terminalId: TerminalId;
  readonly signal: AttentionSignal;
  readonly message: string;
  readonly actions: readonly AttentionAction[];
}

/**
 * Where a notification is shown, and the only part of the notifier that knows
 * an editor exists.
 *
 * `present` returns NOTHING, deliberately. A notification is answered minutes
 * later or never, and a promise nobody awaits is a floating promise; a promise
 * somebody awaits is a decision waiting on a person. Whether a button was
 * pressed is the host's business, and running the command is the host's too --
 * which is also why the request carries a command id rather than a callback:
 * a callback held across a notification's lifetime keeps the terminal, the
 * entry and everything they reference alive for as long as the toast is up.
 */
export interface AttentionPresenter {
  present: (request: AttentionRequest) => void;
}
