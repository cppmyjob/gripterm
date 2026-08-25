import { ValidationError } from '../errors/gripterm-error';
import type { ContextWindowSnapshot } from './context-window-snapshot';
import type { CostSnapshot } from './cost-snapshot';
import type { PersistedTerminalState } from './terminal-state';

/**
 * Whether this snapshot is something that was observed, or something the store
 * stood up in place of one it could not read.
 *
 * A name and not a flag, and for the reason Ш7а gave: the stand-in is
 * `degraded` with no pid and `lastEventAt` set to the record's own creation
 * time, which is the only honest stamp available and is not a sign of life at
 * all. Every watch, reconciler and planner downstream reads that field as
 * evidence -- so a snapshot nobody saw, arriving indistinguishable from one
 * somebody did, is a claim standing in for the absence of one.
 *
 * It is carried rather than derived because nothing downstream can tell the two
 * apart by looking: a `degraded` record with no pid is an ordinary sight.
 */
export type SnapshotProvenance =
  /** Built out of events that reached us. */
  | 'observed'
  /** Invented by the store, because the file holding the real one was gone. */
  | 'recovered';

export interface ObservedStateParams {
  readonly state: PersistedTerminalState;
  readonly lastEventAt: Date;
  readonly currentTool: string | null;
  readonly lastAssistantMessage: string | null;
  readonly cost: CostSnapshot | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly pid: number | null;
  /**
   * Who is working in this conversation right now, or nothing.
   *
   * Optional so that every caller that has no opinion says nothing rather than
   * guessing: an absent list is an empty one, and an empty one means the only
   * thing this build ever knew before -- that `Stop` settles the record.
   */
  readonly running?: readonly string[];
  /**
   * Where this snapshot came from, defaulting to the answer every producer of
   * one has: it was observed.
   *
   * Optional so that the fifty-odd callers that build a state out of events say
   * nothing rather than repeating themselves, and so that the ONE caller that
   * has something else to say -- the codec, standing a snapshot up in place of
   * a file it could not read -- has to say it on purpose.
   */
  readonly provenance?: SnapshotProvenance;
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
  /**
   * The names of everything still running in this conversation: `MAIN_AGENT`
   * for the agent the person is talking to, and one agent id per subagent it
   * started that has not reported its end.
   *
   * Observed, cheap to lose and rebuilt from the journal like everything else
   * here. What it buys is the one thing `Stop` cannot say: the customer's
   * agent, measured on 2026-08-21, went on working for eighty seconds after the
   * hook that this build read as "idle".
   */
  public readonly running: readonly string[];
  /** See `SnapshotProvenance`: `observed` unless the store had to invent this. */
  public readonly provenance: SnapshotProvenance;

  private readonly _lastEventAtMs: number;

  private constructor(params: ObservedStateParams, lastEventAtMs: number) {
    this.state = params.state;
    this._lastEventAtMs = lastEventAtMs;
    this.currentTool = params.currentTool;
    this.lastAssistantMessage = params.lastAssistantMessage;
    this.cost = params.cost;
    this.contextWindow = params.contextWindow;
    this.pid = params.pid;
    this.running = Object.freeze([...params.running ?? []]);
    this.provenance = params.provenance ?? 'observed';
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

  /**
   * The same snapshot, with the process the editor named on it.
   *
   * Its own method because the pid arrives from a channel of its own, after
   * everything else and on the editor's schedule (M2.16): a caller rebuilding
   * the whole state around one field would be writing back whatever it happened
   * to remember about the other six.
   */
  public withPid(pid: number | null): ObservedState {
    return ObservedState.create({
      state: this.state,
      lastEventAt: this.lastEventAt,
      currentTool: this.currentTool,
      lastAssistantMessage: this.lastAssistantMessage,
      cost: this.cost,
      contextWindow: this.contextWindow,
      pid,
      running: this.running,
      // Carried, not cleared. The editor naming a process is not an observation
      // of the state, so a snapshot the store invented is still one it invented
      // after a pid is written on it.
      provenance: this.provenance,
    });
  }
}
