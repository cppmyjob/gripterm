import { ObservedState } from '../entities/observed-state';
import { isHookEvent } from '../events/terminal-event';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { HookDelivery } from '../entities/hook-delivery';
import type { HookEvent, TerminalEvent } from '../events/terminal-event';
import type { HookEventReader } from '../ports/hook-event-reader';
import type { HookEventSink } from '../ports/hook-event-sink';
import type { Logger } from '../ports/logger';
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
 * What a listener is told.
 *
 * It carries the TRANSITION and not just the changed entry, and that is forced
 * rather than convenient: `launch_failed` and an ordinary `ended` are the same
 * target state, told apart only by the state they came from (§4.3). A listener
 * that diffed two entries could not recover the difference, and the attention
 * notifier of M1.11a is built on exactly that distinction.
 *
 * `transition` is null when the entry entered the registry rather than moved.
 */
export interface RegistryChange {
  readonly entry: TerminalEntry;
  readonly transition: StateTransition | null;
}

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
  | { readonly kind: 'foreign' };

const CURRENT: SessionRouting = { kind: 'current' };

/**
 * What each event says about the tool a terminal is running.
 *
 * A total record rather than a `switch`, so that a new member of `TerminalEvent`
 * breaks the build here and has to decide -- without the unreachable `default`
 * branch a `switch` would need in order to say the same thing.
 *
 *   * `name`  -- this event puts a tool in front of the user;
 *   * `clear` -- the tool has finished, or the turn, session or process is over;
 *   * `keep`  -- the event says nothing about tools either way.
 */
const TOOL_RULES: Readonly<Record<TerminalEvent['kind'], 'clear' | 'keep' | 'name'>> = {
  SessionStart: 'clear',
  SessionEnd: 'clear',
  UserPromptSubmit: 'clear',
  PreToolUse: 'name',
  PostToolUse: 'clear',
  PostToolUseFailure: 'clear',
  PermissionRequest: 'name',
  Notification: 'keep',
  Stop: 'clear',
  StopFailure: 'clear',
  CwdChanged: 'keep',
  ResumeTimedOut: 'keep',
  ProcessGone: 'clear',
  TerminalClosed: 'clear',
  LaunchExitedNonZero: 'clear',
  ResumeExitedNonZero: 'clear',
};

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
 * `replaceForeign` from the §4.6 sketch is NOT implemented. Its caller is the
 * repository watcher of M2.5, and M1's base is a map with exactly one owner --
 * there are no foreign entries to project. A method with no caller, tested
 * against an imagined one, is the work that gets redone; the seam it belongs to
 * (`TerminalRepository`) already exists.
 */
export class SessionRegistry implements HookEventSink {
  private readonly _options: SessionRegistryOptions;
  private readonly _entries = new Map<string, TerminalEntry>();
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
    this._notify({ entry, transition: null });
  }

  public get(terminalId: TerminalId): TerminalEntry | undefined {
    return this._entries.get(terminalId.value);
  }

  public list(): readonly TerminalEntry[] {
    return [...this._entries.values()];
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

    const routing = isHookEvent(event) ? this._route(entry, event) : CURRENT;
    if (routing.kind === 'stale') {
      return { kind: 'stale-session' };
    }
    if (routing.kind === 'foreign') {
      return { kind: 'foreign-session' };
    }

    const transition = this._options.stateMachine.apply(entry.observed.state, event);
    if (transition.kind === 'ignored') {
      // `ignored` is the machine saying it DROPPED the event -- which is why it
      // is a separate answer from `stayed`. Nothing is written, including
      // `lastEventAt`: a record whose clock moved for events it refused makes
      // "nothing has happened here for ten minutes" unreadable.
      //
      // A rename cannot be lost here. `SessionStart` is the only event that
      // renames, and it is the machine's resurrection edge -- the one hook it
      // never ignores.
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
    this._notify({ entry: next, transition });
    return { kind: 'accepted', entry: next, transition };
  }

  /**
   * Which record a hook event belongs to, by comparing its `session_id` with
   * `entry.sessionId` -- never with the terminal id from the URL, which is a
   * different identifier by construction and would therefore differ ALWAYS
   * rather than on drift (§4.6).
   */
  private _route(entry: TerminalEntry, event: HookEvent): SessionRouting {
    if (event.sessionId.equals(entry.sessionId)) {
      return CURRENT;
    }

    if (event.kind === 'SessionStart') {
      if (entry.matchesSession(event.sessionId)) {
        // A conversation this terminal has already had. The aggregate refuses
        // to make a past id current again -- that would leave one id both
        // current and past, and the lookup would stop being a lookup -- so this
        // is said out loud and the id left alone. The state still moves: the
        // terminal is demonstrably alive. Recorded as a limit in §8.2, since a
        // restore would then offer the newer conversation and not this one.
        this._options.logger.warn('a terminal announced a session it had used before', {
          terminalId: entry.terminalId.value,
          current: entry.sessionId.value,
          announced: event.sessionId.value,
        });
        return CURRENT;
      }
      // §4.6, case 1. Wider than the plan's `source: "clear"` on purpose:
      // `/resume` onto another conversation, `--fork-session` and `/compact`
      // also begin a session with a new id, and `source` is a field we collapse
      // to `other` whenever we do not recognise it -- so keying the rule on its
      // value would strand a terminal on a label we failed to guess. What makes
      // this safe is the event, not the label: `SessionStart` is the one hook
      // that announces a beginning.
      this._options.logger.info('a terminal changed session', {
        terminalId: entry.terminalId.value,
        from: entry.sessionId.value,
        to: event.sessionId.value,
        source: event.source,
      });
      return { kind: 'renamed', sessionId: event.sessionId };
    }

    if (entry.matchesSession(event.sessionId)) {
      // §4.6, case 2: routed to this record rather than to a phantom terminal,
      // and NOT applied. The plan says "applied to the same record"; the record
      // it belongs to is this one, but the state it would set belongs to a
      // conversation that has ended. A `SessionEnd` still in flight from the
      // session `/clear` replaced would otherwise kill the session that
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
    return { kind: 'foreign' };
  }

  /**
   * Observed state after the event.
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
    const previous = entry.observed;
    return ObservedState.create({
      state: transition.kind === 'moved' ? transition.to : transition.state,
      lastEventAt: this._options.clock.now(),
      currentTool: toolAfter(event, previous.currentTool),
      lastAssistantMessage: messageAfter(event, previous.lastAssistantMessage),
      // Neither has any other producer than the statusline forwarder (M1.8a),
      // and `pid` comes from the gateway. Resetting them on every event would
      // make those channels look broken.
      cost: previous.cost,
      contextWindow: previous.contextWindow,
      pid: previous.pid,
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
          terminalId: change.entry.terminalId.value,
          cause,
        });
      }
    }
  }
}

function toolAfter(event: TerminalEvent, previous: string | null): string | null {
  const rule = TOOL_RULES[event.kind];
  if (rule === 'keep') {
    return previous;
  }
  // A `name` event whose `tool_name` was absent still means a tool is running;
  // it is the one we were not told the name of, and never the previous one --
  // showing a finished tool as the running one is a lie with no expiry.
  return rule === 'name' && 'toolName' in event ? event.toolName : null;
}

function messageAfter(event: TerminalEvent, previous: string | null): string | null {
  if (event.kind === 'Stop') {
    // A missing detail never costs what we already know, which is the parser's
    // rule carried through to the store.
    return event.lastAssistantMessage ?? previous;
  }
  if (event.kind === 'SessionStart') {
    // A new conversation does not inherit the previous one's last words.
    return null;
  }
  return previous;
}
