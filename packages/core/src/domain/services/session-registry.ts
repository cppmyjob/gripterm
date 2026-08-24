import { isAgentEvent } from '../events/terminal-event';
import { observedAfter, runningAfter } from './observed-projection';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { HookDelivery } from '../entities/hook-delivery';
import type { AgentEvent, TerminalEvent } from '../events/terminal-event';
import type { HookEventReader } from '../ports/hook-event-reader';
import type { HookEventSink } from '../ports/hook-event-sink';
import type { ObservedState } from '../entities/observed-state';
import type { Logger } from '../ports/logger';
import type { PersistedTerminalState } from '../entities/terminal-state';
import type { SessionId } from '../entities/session-id';
import type { StateTransition, TerminalStateMachine } from './terminal-state-machine';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';

export interface SessionRegistryOptions {
  readonly stateMachine: TerminalStateMachine;
  readonly reader: HookEventReader;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * One record this window holds moved, arrived or was amended.
 *
 * It carries the TRANSITION and not just the changed entry, and that is forced
 * rather than convenient: `launch_failed` and an ordinary `ended` are the same
 * target state, told apart only by the state they came from (§4.3). A listener
 * that diffed two entries could not recover the difference, and the attention
 * notifier of M1.11a is built on exactly that distinction.
 *
 * `transition` is null when the entry did not move: it was registered, or
 * amended by this window rather than by an event.
 */
export interface EntryChange {
  readonly kind: 'entry';
  readonly entry: TerminalEntry;
  readonly transition: StateTransition | null;
}

/**
 * The records belonging to OTHER windows were replaced, all of them at once.
 *
 * Deliberately carries nothing -- not the entries, not a delta. It comes from
 * `replaceForeign`, whose caller has just re-read the whole base because the
 * file watcher can lose a batch and say so only by handing over no name at all
 * (M2.5); a listener given a delta here would trust something the platform
 * cannot promise.
 *
 * It is a separate member of the union, rather than an entry change with a null
 * transition, so that every listener has to DECIDE about it in front of the
 * compiler. Two of them decide "nothing": interrupting a person about a terminal
 * another window owns, or starting a silence timer for it, are both things this
 * window has no standing to do.
 */
export interface ProjectionChange {
  readonly kind: 'projection';
}

/**
 * A record this window held is gone, because a person threw it away (M2.7).
 *
 * It carries the id and not the entry, which is the shape of what happened: the
 * entry is what a listener would draw, and there is nothing to draw. The two
 * listeners that must act on it act on the id alone -- the writer discards the
 * record from the store, and the observability watch cancels a silence timer
 * that would otherwise announce "Gripterm is not seeing this terminal" about a
 * terminal nobody is looking for.
 *
 * Its own member of the union rather than an entry change carrying a flag, for
 * the same reason `ProjectionChange` is one: a listener that read the flag
 * wrongly would draw a deleted terminal, while a listener that ignores this
 * member draws nothing -- and drawing nothing is the right answer for the three
 * that do ignore it.
 */
export interface RemovalChange {
  readonly kind: 'removed';
  readonly terminalId: TerminalId;
}

/**
 * An event reached one of this window's terminals from a conversation the record
 * has never had -- neither the one it is having nor any it remembers (§4.6,
 * case 3).
 *
 * It is a REFUSAL, and it is published because of what it usually means. The
 * only report that announces a beginning is `ConversationStarted`, and it is
 * the only one that cannot travel over HTTP (H1) -- it goes through the command
 * forwarder,
 * which is a node process that has to start. Lose that one event and every
 * event after it looks like this: a conversation nobody saw begin, talking to a
 * record that is still following the conversation it replaced.
 *
 * The entry travels with it deliberately, unchanged, because the fact alone is
 * not enough to act on -- what makes this worth interrupting a person about is
 * the state the record is in when it happens (see `ObservabilityWatch`). No
 * listener may treat it as a change to the record: nothing about the record
 * moved, which is exactly the complaint.
 */
export interface UnknownConversationChange {
  readonly kind: 'unknown-conversation';
  readonly entry: TerminalEntry;
  readonly sessionId: SessionId;
}

export type RegistryChange =
  | EntryChange
  | ProjectionChange
  | RemovalChange
  | UnknownConversationChange;

export type RegistryListener = (change: RegistryChange) => void;

/**
 * What `ingest` did. The three refusals are §4.6's three unpleasant cases, and
 * they are separate values rather than one `false` because they mean different
 * things: a wrong address, a conversation that has ended, and a session this
 * terminal never had are three different defects to go looking for.
 *
 * `accepted` means the event reached the state machine -- what the machine then
 * did with it is `transition`, which may well be `ignored`.
 */
export type IngestOutcome =
  | {
    readonly kind: 'accepted';
    readonly entry: TerminalEntry;
    readonly transition: StateTransition;
  }
  | { readonly kind: 'unknown-terminal' }
  | { readonly kind: 'stale-session' }
  | { readonly kind: 'foreign-session' };

/** Which record, if any, an event belongs to once its session id has been read. */
type SessionRouting =
  | { readonly kind: 'current' }
  | { readonly kind: 'renamed', readonly sessionId: SessionId }
  | { readonly kind: 'stale' }
  /** Carries the id, because the refusal is published and the id is its substance. */
  | { readonly kind: 'foreign', readonly sessionId: SessionId };

const CURRENT: SessionRouting = { kind: 'current' };

/**
 * The projection of the base for one window, and the only object that decides
 * what an event MEANS for a record.
 *
 * It is a projection and not the source of truth -- the base is (§4.8) -- which
 * is why it writes nothing: persistence subscribes to it (M2) and the lifecycle
 * service registers into it (M1.12). Two consequences worth stating, because
 * both were once the other way round in the drafts:
 *
 *   * `knows` answers for the terminals THIS window holds. An event for someone
 *     else's terminal is refused rather than applied, because only the owning
 *     window may write a record and applying an event is the first half of a
 *     write.
 *   * owner liveness is not here. It lives in the reconciler's own map, so that
 *     it can never reach a persisted field (§4.3, §4.6).
 *
 * Since M2.5 it holds two collections and not one: the records this window owns,
 * and a read-only projection of everyone else's. They are separate MAPS rather
 * than one map with a flag, because the difference is not decoration -- `ingest`,
 * `amend`, `get` and `stateOf` all answer for this window's records only, and a
 * single collection would make "only the owning window may apply an event" a
 * rule held by a condition somebody could forget instead of by the lookup
 * itself.
 */
export class SessionRegistry implements HookEventSink {
  private readonly _options: SessionRegistryOptions;
  private readonly _entries = new Map<string, TerminalEntry>();
  /** Other windows' records, as the base last showed them. Never written back. */
  private readonly _foreign = new Map<string, TerminalEntry>();
  private readonly _listeners = new Set<RegistryListener>();

  constructor(options: SessionRegistryOptions) {
    this._options = options;
  }

  /** Puts an entry under this window's care. Replaces one already held, loudly. */
  public register(entry: TerminalEntry): void {
    if (this._entries.has(entry.terminalId.value)) {
      // Not refused: a caller with a newer instance is exactly what a projection
      // is for. But the previous instance carried observed state -- the phase,
      // the last message, the running tool -- and dropping that without a word
      // would leave nothing to read afterwards.
      this._options.logger.info('a registration replaced an entry this window already held', {
        terminalId: entry.terminalId.value,
      });
    }
    this._entries.set(entry.terminalId.value, entry);
    // A record this window has just taken on is no longer somebody else's, and
    // leaving the projected copy in place would show it twice -- which is what
    // adoption (M2.10) does every time it succeeds.
    this._foreign.delete(entry.terminalId.value);
    this._notify({ kind: 'entry', entry, transition: null });
  }

  /**
   * The records of other windows, as the base last showed them.
   *
   * Called by the repository watcher after `readAll()` (§4.6) -- which is the
   * whole of "a change in another window is visible here", and the reason the
   * argument is the ENTIRE list rather than what changed: the watcher cannot
   * know what changed, and neither can the platform underneath it.
   *
   * Records this window owns are skipped even when the base offers them, because
   * what is in memory here is newer than what is on disk by however long the
   * write debounce is (M2.6). The base is the source of truth about OTHER
   * windows; about ours, we are.
   */
  public replaceForeign(entries: readonly TerminalEntry[]): void {
    this._foreign.clear();
    for (const entry of entries) {
      if (!this._entries.has(entry.terminalId.value)) {
        this._foreign.set(entry.terminalId.value, entry);
      }
    }
    this._notify({ kind: 'projection' });
  }

  /**
   * A change this window made to a record it already holds -- `closedAt`
   * (M1.12), a rename, a note (M2.7). Not an event, so no transition.
   *
   * Separate from `register`, because the two want opposite things when the id
   * is not there. Registering an unheld entry is how a terminal joins this
   * window; amending one is a caller talking about a terminal that has already
   * gone, and creating the record back would resurrect something this window
   * stopped owning. So this one refuses, and says so.
   */
  public amend(next: TerminalEntry): void {
    if (!this._entries.has(next.terminalId.value)) {
      this._options.logger.warn('an amendment named a terminal this window does not hold', {
        terminalId: next.terminalId.value,
      });
      return;
    }
    this._entries.set(next.terminalId.value, next);
    this._notify({ kind: 'entry', entry: next, transition: null });
  }

  /**
   * Drops a record this window holds, because the person deleted it (M2.7).
   *
   * Refuses an id it does not hold, exactly as `amend` does and for the same
   * reason: a caller naming a terminal this window never had is a caller working
   * from a stale list, and doing nothing is the only answer that cannot make it
   * worse. Another window's record is not touched either -- deleting one is a
   * write into a file this window may not write (§4.8).
   *
   * The store is NOT touched here. This class writes nothing; the removal
   * travels to the disk the same way every other change does, through the
   * listener the writer registered (M2.6). That matters for the order: a write
   * of this record still queued behind us is replaced by the removal rather than
   * racing it.
   */
  public forget(terminalId: TerminalId): void {
    if (!this._entries.delete(terminalId.value)) {
      this._options.logger.warn('a removal named a terminal this window does not hold', {
        terminalId: terminalId.value,
      });
      return;
    }
    this._notify({ kind: 'removed', terminalId });
  }

  /**
   * A record THIS window holds. Another window's is deliberately not returned.
   *
   * Every caller of this is about to act -- focus it, close it, amend it -- and
   * none of those are things this window may do to a record it does not own. A
   * lookup that answered for foreign records would make each of those callers
   * carry the check instead.
   */
  public get(terminalId: TerminalId): TerminalEntry | undefined {
    return this._entries.get(terminalId.value);
  }

  /**
   * Everything to draw: this window's records first, then everyone else's.
   *
   * The order is not alphabetical and not by urgency -- a list that reorders
   * itself while being read is a list you click the wrong row in -- so within
   * each group it stays the order they arrived in.
   */
  public list(): readonly TerminalEntry[] {
    return [...this._entries.values(), ...this._foreign.values()];
  }

  /**
   * Only the records this window holds.
   *
   * The list a caller wants when it is about to OFFER something -- a picker, a
   * count in the status bar -- rather than to draw everything. Its own method
   * because the alternative, filtering `list()` by asking `knows` about each
   * row, is the same rule written out at every call site, and one of them would
   * eventually be written differently: the close picker was, and it offered
   * another window's terminals in a dialog that then blocked on a choice this
   * window could not act on.
   */
  public own(): readonly TerminalEntry[] {
    return [...this._entries.values()];
  }

  /**
   * The state of a terminal this window holds, or `null` when it holds none.
   *
   * It exists so that the one caller who needs the state and not the record --
   * the lifecycle service, deciding what a closing terminal means -- does not
   * have to carry a branch for a case it cannot reach. Here that branch is one
   * call away from a test; there it would be unreachable code, which is the
   * kind that quietly stops being true.
   */
  public stateOf(terminalId: TerminalId): PersistedTerminalState | null {
    return this._entries.get(terminalId.value)?.observed.state ?? null;
  }

  public subscribe(listener: RegistryListener): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  public knows(terminalId: TerminalId): boolean {
    return this._entries.has(terminalId.value);
  }

  /**
   * The sink side: a body, verbatim, after the response has already gone out.
   *
   * Returns nothing and throws nothing. There is nobody left to tell -- the
   * conversation was answered a moment ago -- so every refusal here is a log
   * line, and the body itself is already in the journal whatever we make of it.
   */
  public receive(delivery: HookDelivery): void {
    const reading = this._options.reader.read(delivery.raw);
    switch (reading.status) {
      case 'parsed':
        this.ingest(delivery.terminalId, reading.event);
        return;

      case 'ignored':
        // Ordinary traffic, not a failure: the CLI emits well over thirty event
        // types and we model eleven. A warning apiece would drown the ones that
        // matter.
        this._options.logger.info('a hook event we do not model', {
          terminalId: delivery.terminalId.value,
          hookEventName: reading.hookEventName,
        });
        return;

      case 'malformed':
        // A body that is not a hook payload is a symptom -- a wrong port, a
        // proxy, a contract that moved under us -- and it is worth saying so.
        this._options.logger.warn('a hook payload could not be read', {
          terminalId: delivery.terminalId.value,
          reason: reading.reason,
        });
        return;
    }
  }

  /**
   * The one path from an event to a record, for hook events and synthetic ones
   * alike.
   *
   * Order matters and is the substance of §4.6: address first (is this terminal
   * ours), then identity (is this event from the conversation this record is
   * having), then state. Turning the first two around would let a stranger's
   * session decide which of our terminals to talk about.
   */
  public ingest(terminalId: TerminalId, event: TerminalEvent): IngestOutcome {
    const entry = this._entries.get(terminalId.value);
    if (entry === undefined) {
      // §4.6, case 3: dropped, and deliberately NOT created. The receiver
      // already answers 404 for this on the request path; getting here means a
      // terminal was dropped between the two calls, and the answer must be the
      // same either way -- otherwise the loopback port is a way to invent
      // records from outside.
      this._options.logger.warn('an event named a terminal this window does not hold', {
        terminalId: terminalId.value,
        event: event.kind,
      });
      return { kind: 'unknown-terminal' };
    }

    const routing = isAgentEvent(event) ? this._route(entry, event) : CURRENT;
    if (routing.kind === 'stale') {
      return { kind: 'stale-session' };
    }
    if (routing.kind === 'foreign') {
      // Told, as well as logged. What this usually is -- a beginning that never
      // arrived, leaving the record on a conversation that has been
      // replaced -- is invisible from here: it takes the record's own state to
      // tell "we missed a beginning" from "something we have not measured also
      // posts to this address". So the fact goes out and the judgement is made
      // by whoever is watching (M2.8).
      this._notify({ kind: 'unknown-conversation', entry, sessionId: routing.sessionId });
      return { kind: 'foreign-session' };
    }

    const transition = this._options.stateMachine.apply(
      entry.observed.state,
      event,
      runningAfter(entry.observed.running, event)
    );
    if (transition.kind === 'ignored') {
      // `ignored` is the machine saying it DROPPED the event -- which is why it
      // is a separate answer from `stayed`. Nothing is written, including
      // `lastEventAt`: a record whose clock moved for events it refused makes
      // "nothing has happened here for ten minutes" unreadable.
      //
      // A rename cannot be lost here. `ConversationStarted` is the only event
      // that renames, and it is the machine's resurrection edge -- the one
      // report it never ignores.
      this._options.logger.info('an event was not applied', {
        terminalId: terminalId.value,
        event: event.kind,
        state: transition.state,
        reason: transition.reason,
      });
      return { kind: 'accepted', entry, transition };
    }

    const renamed = routing.kind === 'renamed' ? entry.withSessionId(routing.sessionId) : entry;
    const next = renamed.withObserved(this._observedAfter(entry, event, transition));
    this._entries.set(terminalId.value, next);
    this._notify({ kind: 'entry', entry: next, transition });
    return { kind: 'accepted', entry: next, transition };
  }

  /**
   * Which record a hook event belongs to, by comparing its `session_id` with
   * `entry.sessionId` -- never with the terminal id from the URL, which is a
   * different identifier by construction and would therefore differ ALWAYS
   * rather than on drift (§4.6).
   */
  private _route(entry: TerminalEntry, event: AgentEvent): SessionRouting {
    if (event.sessionId.equals(entry.sessionId)) {
      return CURRENT;
    }

    if (event.kind === 'ConversationStarted') {
      // §4.6, case 1. Wider than the plan's `source: "clear"` on purpose:
      // `/resume` onto another conversation, `--fork-session` and `/compact`
      // also begin a session with a new id, and `source` is a field we collapse
      // to `other` whenever we do not recognise it -- so keying the rule on its
      // value would strand a terminal on a label we failed to guess. What makes
      // this safe is the event, not the label: `ConversationStarted` is the one
      // report that announces a beginning.
      //
      // A conversation this terminal has ALREADY had is followed too, and it is
      // the same rule rather than an exception to it. That case was refused
      // until A19 measured it (2026-08-12): `/resume <id>` typed into the
      // terminal reports an end (reason: resume) and then this event with an
      // id out of our own history. Left alone, the record went on naming the
      // conversation the person had just walked away from -- and that is the
      // one a restore would have offered them.
      this._options.logger.info('a terminal changed session', {
        terminalId: entry.terminalId.value,
        from: entry.sessionId.value,
        to: event.sessionId.value,
        source: event.source,
        returning: entry.matchesSession(event.sessionId),
      });
      return { kind: 'renamed', sessionId: event.sessionId };
    }

    if (entry.matchesSession(event.sessionId)) {
      // §4.6, case 2: routed to this record rather than to a phantom terminal,
      // and NOT applied. The plan says "applied to the same record"; the record
      // it belongs to is this one, but the state it would set belongs to a
      // conversation that has ended. A `ConversationEnded` still in flight from
      // the session `/clear` replaced would otherwise kill the session that
      // replaced it.
      this._options.logger.warn('an event arrived from a session this terminal has left', {
        terminalId: entry.terminalId.value,
        current: entry.sessionId.value,
        arrived: event.sessionId.value,
        event: event.kind,
      });
      return { kind: 'stale' };
    }

    this._options.logger.warn('an event named a session this terminal never had', {
      terminalId: entry.terminalId.value,
      current: entry.sessionId.value,
      arrived: event.sessionId.value,
      event: event.kind,
    });
    return { kind: 'foreign', sessionId: event.sessionId };
  }

  /**
   * Observed state after the event, by the same rule the replay of a journal
   * uses (`observedAfter`). One rule and not two: a second copy would be a
   * second answer to "what does `ToolStarted` mean", and the two would disagree
   * exactly where nobody looks -- a terminal restored from its journal showing a
   * different tool from the one the live window showed a minute earlier.
   *
   * The time comes from the clock rather than from `HookDelivery.receivedAt`,
   * although both are within a millisecond of each other here. `ingest` is one
   * path for hook events and synthetic ones, and only half of them carry an
   * arrival time; two sources of "now" in one record is how a timeline stops
   * being comparable with itself.
   */
  private _observedAfter(
    entry: TerminalEntry,
    event: TerminalEvent,
    transition: StateTransition
  ): ObservedState {
    return observedAfter({
      previous: entry.observed,
      event,
      transition,
      at: this._options.clock.now(),
    });
  }

  /**
   * Listeners are the tree view, the status bar and later persistence. One of
   * them failing must not stop the next from being told, and must not surface
   * as "the event was not applied" -- it was.
   *
   * Different from `InMemoryTerminalRepository`, which lets a listener's error
   * propagate. That class has no logger and should not acquire one; this one
   * does, so swallowing here leaves a trace rather than a silence.
   */
  private _notify(change: RegistryChange): void {
    for (const listener of this._listeners) {
      try {
        listener(change);
      } catch (cause: unknown) {
        this._options.logger.error('a registry listener threw while being told of a change', {
          terminalId: terminalIdOf(change),
          cause,
        });
      }
    }
  }
}

/**
 * Which record a change is about, for a log line.
 *
 * A projection change names no terminal, and inventing one would send whoever
 * reads it looking at the wrong record. The other two do name one, and a
 * listener that threw while being told a record was deleted is worth being able
 * to find.
 */
function terminalIdOf(change: RegistryChange): string | null {
  switch (change.kind) {
    case 'entry':
    case 'unknown-conversation':
      return change.entry.terminalId.value;
    case 'removed':
      return change.terminalId.value;
    case 'projection':
      return null;
  }
}

