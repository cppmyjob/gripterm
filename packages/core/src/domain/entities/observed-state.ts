import { ValidationError } from '../errors/gripterm-error.js';
import type { ContextWindowSnapshot } from './context-window-snapshot.js';
import type { CostSnapshot } from './cost-snapshot.js';
import type { PersistedTerminalState } from './terminal-state.js';

export interface ObservedStateParams {
  readonly state: PersistedTerminalState;
  readonly lastEventAt: Date;
  readonly currentTool: string | null;
  readonly lastAssistantMessage: string | null;
  readonly cost: CostSnapshot | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly pid: number | null;
}

/**
 * What we have observed about the terminal. Rebuilt from events, never
 * authoritative, and cheap to lose -- which is the difference between this and
 * `HumanMetadata`.
 *
 * Two fields have a history of being misread, so their provenance is stated
 * here:
 *
 *   * `state` is a `PersistedTerminalState`. `detached` never reaches it; the
 *     presenter lays that over the value at display time, and that overlay is
 *     the single place it happens.
 *   * `lastAssistantMessage` comes from the `Stop` hook's
 *     `last_assistant_message` field, which the CLI documents as existing
 *     precisely so that nobody has to read and parse a transcript.
 */
export class ObservedState {
  public readonly state: PersistedTerminalState;
  public readonly currentTool: string | null;
  public readonly lastAssistantMessage: string | null;
  public readonly cost: CostSnapshot | null;
  public readonly contextWindow: ContextWindowSnapshot | null;
  public readonly pid: number | null;

  private readonly _lastEventAtMs: number;

  private constructor(params: ObservedStateParams, lastEventAtMs: number) {
    this.state = params.state;
    this._lastEventAtMs = lastEventAtMs;
    this.currentTool = params.currentTool;
    this.lastAssistantMessage = params.lastAssistantMessage;
    this.cost = params.cost;
    this.contextWindow = params.contextWindow;
    this.pid = params.pid;
    Object.freeze(this);
  }

  /** A fresh `Date` each time: see the note on `Note.at`. */
  public get lastEventAt(): Date {
    return new Date(this._lastEventAtMs);
  }

  public static create(params: ObservedStateParams): ObservedState {
    if (Number.isNaN(params.lastEventAt.getTime())) {
      throw new ValidationError('lastEventAt must be a valid date');
    }
    if (params.pid !== null && (!Number.isInteger(params.pid) || params.pid <= 0)) {
      throw new ValidationError('pid must be a positive integer or null', {
        details: { pid: params.pid },
      });
    }
    return new ObservedState(params, params.lastEventAt.getTime());
  }
}
