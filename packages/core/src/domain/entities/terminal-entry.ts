import { ValidationError } from '../errors/gripterm-error';
import type { HumanMetadata } from './human-metadata';
import type { LaunchRecipe } from './launch-recipe';
import type { ObservedState } from './observed-state';
import type { OwnerRef } from './owner-ref';
import type { SessionId } from './session-id';
import type { TerminalId } from './terminal-id';

const INITIAL_REVISION = 0;

/** The stored form. `Date`s are held as epoch milliseconds -- see `createdAt`. */
interface TerminalEntryState {
  readonly terminalId: TerminalId;
  readonly sessionId: SessionId;
  readonly sessionIdHistory: readonly SessionId[];
  readonly owner: OwnerRef;
  readonly metadata: HumanMetadata;
  readonly launch: LaunchRecipe;
  readonly observed: ObservedState;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
  readonly revision: number;
}

export interface CreateTerminalEntryParams {
  readonly terminalId: TerminalId;
  readonly sessionId: SessionId;
  readonly owner: OwnerRef;
  readonly metadata: HumanMetadata;
  readonly launch: LaunchRecipe;
  readonly observed: ObservedState;
  readonly createdAt: Date;
  readonly sessionIdHistory?: readonly SessionId[];
  readonly closedAt?: Date | null;
  readonly revision?: number;
}

/**
 * One terminal, as this extension knows it. Every mutator returns a new
 * instance, which gives the UI a cheap identity comparison for redrawing and
 * makes rolling a state back a matter of keeping the previous reference.
 *
 * Three invariants of the storage design are expressed by the structure rather
 * than by a comment: `terminalId` and `sessionId` are different types; human
 * metadata and observed state are different objects with different guarantees;
 * and `launch` holds the whole recipe rather than an id.
 */
export class TerminalEntry {
  private readonly _state: TerminalEntryState;

  private constructor(state: TerminalEntryState) {
    this._state = Object.freeze({
      ...state,
      sessionIdHistory: Object.freeze([...state.sessionIdHistory]),
    });
    Object.freeze(this);
  }

  public get terminalId(): TerminalId {
    return this._state.terminalId;
  }

  public get sessionId(): SessionId {
    return this._state.sessionId;
  }

  /** Ids this terminal used before, most recent last. */
  public get sessionIdHistory(): readonly SessionId[] {
    return this._state.sessionIdHistory;
  }

  public get owner(): OwnerRef {
    return this._state.owner;
  }

  public get metadata(): HumanMetadata {
    return this._state.metadata;
  }

  public get launch(): LaunchRecipe {
    return this._state.launch;
  }

  public get observed(): ObservedState {
    return this._state.observed;
  }

  /**
   * A fresh `Date` on every read. `Object.freeze` does not reach a `Date`'s
   * internal slots, so a shared instance would stay mutable through `setTime`
   * however many `readonly` keywords surrounded it -- copying in and out is the
   * only spelling under which the immutability of this class is true.
   */
  public get createdAt(): Date {
    return new Date(this._state.createdAtMs);
  }

  /**
   * Set ONLY by an explicit human action -- closing or deleting the terminal.
   * The `claude` process exiting does not set it: our terminals are transient
   * and therefore die on every editor shutdown, so tying this to process exit
   * would declare everything rubbish after the first one, and would leave
   * `isRestorable` with nothing to say.
   */
  public get closedAt(): Date | null {
    const { closedAtMs } = this._state;
    return closedAtMs === null ? null : new Date(closedAtMs);
  }

  /**
   * Optimistic concurrency for `record.json`. Advanced by the repository on
   * write -- and by `adoptedBy`, which is the one change to this record that
   * IS the compare-and-swap. See the note there.
   */
  public get revision(): number {
    return this._state.revision;
  }

  public static create(params: CreateTerminalEntryParams): TerminalEntry {
    if (Number.isNaN(params.createdAt.getTime())) {
      throw new ValidationError('createdAt must be a valid date');
    }

    const revision = params.revision ?? INITIAL_REVISION;
    if (!Number.isInteger(revision) || revision < INITIAL_REVISION) {
      throw new ValidationError('revision must be a non-negative integer', {
        details: { revision },
      });
    }

    const history = params.sessionIdHistory ?? [];
    if (history.some((past) => past.equals(params.sessionId))) {
      throw new ValidationError('the current sessionId must not also appear in its history', {
        details: { sessionId: params.sessionId.value },
      });
    }

    const closedAt = params.closedAt ?? null;
    if (closedAt !== null) {
      TerminalEntry._assertClosable(closedAt, params.createdAt.getTime());
    }

    return new TerminalEntry({
      terminalId: params.terminalId,
      sessionId: params.sessionId,
      sessionIdHistory: history,
      owner: params.owner,
      metadata: params.metadata,
      launch: params.launch,
      observed: params.observed,
      createdAtMs: params.createdAt.getTime(),
      closedAtMs: closedAt === null ? null : closedAt.getTime(),
      revision,
    });
  }

  private static _assertClosable(at: Date, createdAtMs: number): void {
    if (Number.isNaN(at.getTime())) {
      throw new ValidationError('closedAt must be a valid date');
    }
    if (at.getTime() < createdAtMs) {
      throw new ValidationError('closedAt must not precede createdAt', {
        details: { closedAt: at.toISOString(), createdAt: new Date(createdAtMs).toISOString() },
      });
    }
  }

  /**
   * Deliberately does NOT touch `revision`: a debounced write of observed state
   * would otherwise rewrite `record.json` as well, and separating the two by
   * write frequency is the reason there are two files.
   */
  public withObserved(next: ObservedState): TerminalEntry {
    return this._withState({ observed: next });
  }

  public withMetadata(next: HumanMetadata): TerminalEntry {
    return this._withState({ metadata: next });
  }

  /**
   * Records the session id drifting -- `/clear`, `/branch`, `--fork-session`.
   * The previous id moves into the history so that events still in flight from
   * the dying session find their terminal instead of creating a phantom one.
   *
   * Returns `this` when the id has not moved. Throws when the new id is one the
   * terminal already used: the CLI never reissues an id, so that can only be a
   * caller's mistake, and accepting it would leave the same id both current and
   * past, making the lookup ambiguous.
   */
  public withSessionId(next: SessionId): TerminalEntry {
    if (this._state.sessionId.equals(next)) {
      return this;
    }
    if (this._state.sessionIdHistory.some((past) => past.equals(next))) {
      throw new ValidationError('a previous sessionId cannot become the current one again', {
        details: { sessionId: next.value },
      });
    }
    return this._withState({
      sessionId: next,
      sessionIdHistory: [...this._state.sessionIdHistory, this._state.sessionId],
    });
  }

  /**
   * Transfers ownership. Adoption is permitted only once the previous owner has
   * been judged dead -- and that judgement is the CALLER's, not this object's:
   * liveness lives in the reconciler's in-memory map, deliberately outside the
   * aggregate, so that it can never leak into a persisted field.
   *
   * What can be checked here is checked: a living owner is never displaced,
   * including by itself, so re-adopting under the same owner id is refused
   * rather than silently producing a new instance.
   *
   * The revision advances HERE rather than in the repository, unlike every
   * other write. Adoption is the compare-and-swap itself -- a caller reads
   * revision R, adopts with `expected: R`, and stores the result. Leave the
   * number alone and two windows adopting the same abandoned terminal both pass
   * their check and both start `claude --resume` on one conversation. The rule
   * belongs where it cannot be forgotten by the next implementation of the
   * repository, and that is here.
   */
  public adoptedBy(next: OwnerRef): TerminalEntry {
    if (this._state.owner.ownerId.equals(next.ownerId)) {
      throw new ValidationError('an entry cannot be adopted by its current owner', {
        details: { ownerId: next.ownerId.value },
      });
    }
    return this._withState({ owner: next, revision: this._state.revision + 1 });
  }

  /** Idempotent: the first close wins, so a second one cannot move the timestamp. */
  public withClosed(at: Date): TerminalEntry {
    if (this._state.closedAtMs !== null) {
      return this;
    }
    TerminalEntry._assertClosable(at, this._state.createdAtMs);
    return this._withState({ closedAtMs: at.getTime() });
  }

  /**
   * Answers only the part the aggregate can answer: an entry the human closed
   * is gone for good.
   *
   * It is NOT the whole restore predicate. A session that never received a
   * prompt leaves no transcript at all, so `--resume` on it fails with exit
   * code 1 -- measured. Filtering those out needs the file system and belongs
   * to the restore service; without it every editor restart would produce a
   * batch of false `resume_failed`.
   */
  public isRestorable(): boolean {
    return this._state.closedAtMs === null;
  }

  /** True when `candidate` is this terminal's session id now or was one before. */
  public matchesSession(candidate: SessionId): boolean {
    return (
      this._state.sessionId.equals(candidate) ||
      this._state.sessionIdHistory.some((past) => past.equals(candidate))
    );
  }

  /**
   * True when any conversation this terminal has had appears among those ids.
   *
   * The same question as `matchesSession`, asked of a SET rather than of one
   * candidate, because that is the shape the CLI's answer arrives in. It lives
   * here rather than in either of its callers -- the restore planner and the
   * reconciler -- so that the two cannot answer it differently: a conversation
   * this terminal used to be is still running under an id we handed out, and a
   * reader that forgot the history would let something start a second process
   * on it.
   */
  public claimsAnyOf(sessionIds: ReadonlySet<string>): boolean {
    return (
      sessionIds.has(this._state.sessionId.value) ||
      this._state.sessionIdHistory.some((past) => sessionIds.has(past.value))
    );
  }

  private _withState(changes: Partial<TerminalEntryState>): TerminalEntry {
    return new TerminalEntry({ ...this._state, ...changes });
  }
}
