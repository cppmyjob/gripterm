import { ValidationError } from '../errors/gripterm-error';
import type { HumanMetadata } from './human-metadata';
import type { LaunchRecipe } from './launch-recipe';
import type { ObservedState } from './observed-state';
import type { OwnerRef } from './owner-ref';
import type { SessionId } from './session-id';
import type { TerminalEngine } from './terminal-engine';
import type { TerminalId } from './terminal-id';

const INITIAL_REVISION = 0;

/**
 * Which hand closed a terminal, measured 2026-08-24 to be two different things
 * the editor reports with one word.
 *
 * `person` is our own Close, reached through our list: they were reading the
 * row, they meant that conversation, and nothing else went with it.
 *
 * `editor` is the terminal going away with `reason: 'user'` -- the cross on the
 * tab, and ALSO every bulk gesture the editor offers. Measured on this build:
 * one `workbench.action.closeAllEditors` closes every conversation in the
 * window and each one arrives as its own event, `closed: 1`, within fifty
 * milliseconds of the others. There is no signal in the platform that separates
 * "I am done with this conversation" from "I am tidying my tabs", and this
 * build does not pretend to have one.
 *
 * So it stops guessing at the intention and narrows the CONSEQUENCE instead:
 * both hands stop a record coming back by itself, and only `person` may feed
 * the sweep that moves records out of the store while nobody is looking. What
 * a misread costs is then one row a person did not want, and not a conversation.
 */
export type ClosedBy = 'person' | 'editor';

/** The stored form. `Date`s are held as epoch milliseconds -- see `createdAt`. */
interface TerminalEntryState {
  readonly terminalId: TerminalId;
  readonly sessionId: SessionId;
  readonly sessionIdHistory: readonly SessionId[];
  readonly owner: OwnerRef;
  readonly metadata: HumanMetadata;
  readonly launch: LaunchRecipe;
  readonly observed: ObservedState;
  readonly engine: TerminalEngine;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
  readonly closedBy: ClosedBy | null;
  readonly revision: number;
  /** Where the person put this terminal among the others, or `null`. See `placement`. */
  readonly order: number | null;
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
  /**
   * Which of the two acts closed it, or `null` for a record written before this
   * build could tell them apart.
   */
  readonly closedBy?: ClosedBy | null;
  readonly revision?: number;
  /**
   * Which engine made the terminal, defaulting to `editor`.
   *
   * Optional because it has one honest default and the default is the safe
   * direction: every record written before this field existed says nothing about
   * the engine, and reconciliation may kill the processes of `own` and only
   * those. Reading silence as `own` would point it at a `claude` that outlives
   * the extension host by design (M2.16). Reading it as `editor` costs a process
   * that is not cleaned up; reading it the other way costs a conversation.
   */
  readonly engine?: TerminalEngine;
  /**
   * Where the person put this terminal among the others, if they ever did.
   *
   * Optional for the reason `engine` is: every record written before this field
   * existed has no arrangement, and the honest reading of that silence is "where
   * it was made" (`placement`).
   */
  readonly order?: number | null;
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

  /**
   * The engine that MADE this terminal, which is not the same thing as the engine
   * the settings ask for: they part company on every fallback (see
   * `TerminalEngine`). Only `own` processes may be killed by reconciliation, so
   * this field is read before anything ends a process.
   */
  public get engine(): TerminalEngine {
    return this._state.engine;
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
   * Where the person put this terminal among the others, or `null` if they never
   * did.
   *
   * `null` and not a number, so that "never arranged" stays a fact rather than
   * being written down as an arrangement that happens to equal the default.
   */
  public get order(): number | null {
    return this._state.order;
  }

  /**
   * The number the tabs and the rows are sorted by: the arrangement if there is
   * one, and otherwise the moment this terminal was made.
   *
   * ONE number space for both kinds of record, which is what keeps a drag
   * between an arranged tab and an unarranged one an ordinary comparison. It is
   * also why the default is the creation moment rather than zero: zero would put
   * every old record in front of every new one, and the moment is exactly the
   * order the person watched the tabs appear in.
   */
  public get placement(): number {
    return this._state.order ?? this._state.createdAtMs;
  }

  /**
   * Set ONLY by an explicit human action: closing the terminal from our list, or
   * closing it in the editor itself -- which the platform names `user` and
   * nothing else (A29).
   *
   * The `claude` process exiting does not set it, and neither does the window
   * going away: our terminals are transient and therefore die on every editor
   * shutdown, so reading either as intent would declare everything rubbish after
   * the first one, and would leave `isRestorable` with nothing to say.
   */
  public get closedAt(): Date | null {
    const { closedAtMs } = this._state;
    return closedAtMs === null ? null : new Date(closedAtMs);
  }

  /**
   * Which act closed it, and `null` when nothing did -- or when the record was
   * written by a build that could not tell.
   *
   * Read by the cleanup planner and by nothing else, because it answers one
   * question: may this record be taken out of the store while nobody is
   * looking. See `ClosedBy`.
   */
  public get closedBy(): ClosedBy | null {
    return this._state.closedBy;
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
      engine: params.engine ?? 'editor',
      createdAtMs: params.createdAt.getTime(),
      closedAtMs: closedAt === null ? null : closedAt.getTime(),
      closedBy: closedAt === null ? null : (params.closedBy ?? null),
      revision,
      order: params.order ?? null,
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
   * Puts this terminal at a place among the others (owner's decision
   * 2026-08-21).
   *
   * Deliberately does NOT touch `revision`, like `withMetadata`: this is the
   * owning window writing down something its own person did to its own record,
   * not a transfer another window has to lose a compare-and-swap over. Returns
   * `this` when the number has not moved, which keeps the identity comparison
   * the UI redraws on.
   */
  public withOrder(next: number): TerminalEntry {
    return this._state.order === next ? this : this._withState({ order: next });
  }

  /**
   * Records which engine made the terminal that is running now.
   *
   * Called by the lifecycle service with the engine of the gateway that just
   * created it -- once, immediately after the create -- so a record restored by a
   * window running the other engine stops claiming the one it was stored with.
   *
   * Deliberately does NOT touch `revision`, like `withObserved`: this is us
   * writing down what we just did, not a change another window has to lose a
   * compare-and-swap over. Returns `this` when the engine has not moved, which is
   * the ordinary case and keeps the identity comparison the UI redraws on.
   */
  public withEngine(next: TerminalEngine): TerminalEntry {
    return this._state.engine === next ? this : this._withState({ engine: next });
  }

  /**
   * Records the session id moving -- `/clear`, `/branch`, `--fork-session`, and
   * a `/resume` back onto a conversation this terminal has already had.
   *
   * The previous id moves into the history so that events still in flight from
   * the dying session find their terminal instead of creating a phantom one.
   * Returns `this` when the id has not moved.
   *
   * **Returning to a past id is a SWAP**, not an append: that id leaves the
   * history and the current one takes its place there. This case threw until
   * 2026-08-12, on the premise that the CLI never reissues an id -- and A19
   * measured the opposite, that `/resume <id>` inside a terminal announces
   * itself with `SessionStart` carrying exactly such an id. What the refusal was
   * protecting survives the change and is the reason it is a swap: one id is
   * never both current and past, so the lookup stays a lookup.
   *
   * What is lost is the knowledge that this conversation was also had EARLIER.
   * The history exists to route late events, not to keep an itinerary, and both
   * ids are in it either way.
   */
  public withSessionId(next: SessionId): TerminalEntry {
    if (this._state.sessionId.equals(next)) {
      return this;
    }
    return this._withState({
      sessionId: next,
      sessionIdHistory: [
        ...this._state.sessionIdHistory.filter((past) => !past.equals(next)),
        this._state.sessionId,
      ],
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

  /**
   * Takes the close back, because the person who made it asked for this
   * conversation again (M2.23).
   *
   * The only mutator in this class that undoes another one, and it is allowed
   * for the reason `closedAt` exists at all: that field is an INTENTION -- "do
   * not bring this back" -- and not a fact about the world, which is why nothing
   * a process does ever sets it (see `closedAt`). An intention is the kind of
   * thing its author may reverse, and until this existed they could not: a
   * terminal closed by mistake left a record no window would ever resume, whose
   * only offer was a NEW conversation.
   *
   * It changes nothing else, `revision` included. This is not a transfer and not
   * a write another window has to lose a compare-and-swap over -- the record is
   * already ours, and what moves is one field of it.
   */
  public reopened(): TerminalEntry {
    return this._state.closedAtMs === null
      ? this
      : this._withState({ closedAtMs: null, closedBy: null });
  }

  /**
   * Idempotent: the first close wins, so a second one cannot move the timestamp
   * -- nor the hand it names.
   *
   * `by` is not decoration. Both hands write the same `closedAt` and mean the
   * same thing to the restore predicate, and only one of them may feed the
   * sweep that moves records out of the store unasked. See `ClosedBy`.
   */
  public withClosed(at: Date, by: ClosedBy): TerminalEntry {
    if (this._state.closedAtMs !== null) {
      return this;
    }
    TerminalEntry._assertClosable(at, this._state.createdAtMs);
    return this._withState({ closedAtMs: at.getTime(), closedBy: by });
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
