import {
  ContextWindowSnapshot,
  CostSnapshot,
  HookEventParser,
  ObservedState,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  processGone,
  terminalClosed,
  type EntryChange,
  type HookEventContext,
  type NotificationEvent,
  type NotificationType,
  type PermissionRequestEvent,
  type PersistedTerminalState,
  type PostToolUseEvent,
  type PreToolUseEvent,
  type RegistryChange,
  type SessionEndEvent,
  type SessionStartEvent,
  type SessionStartSource,
  type StopEvent,
  type TerminalEntry,
  type UnknownConversationChange,
  type UserPromptSubmitEvent,
} from '../../packages/core/src/index';
import {
  CREATED_AT,
  NEXT_SESSION_UUID,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeMetadata,
  makeOwnerRef,
} from '../helpers/domain-fixtures';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';

/**
 * The registry is the only object in the system that decides what an event
 * MEANS for a record, so this file is where §4.6's three unpleasant cases are
 * settled -- and each of them is a way for the sidebar to start lying rather
 * than to fail:
 *
 *   * an event for a terminal we do not hold must not CREATE one, or the
 *     loopback port becomes a way to invent records from outside;
 *   * an event whose `session_id` moved must rename the record, or the terminal
 *     freezes at whatever it was doing when the user typed `/clear` (П1);
 *   * an event from a session the terminal has already left must not be applied,
 *     or a dead conversation gets to say what the live one is doing.
 *
 * The state machine is the real one, not a double. What is being checked here
 * is the wiring -- which entry, which session, which observed field -- and a
 * fake machine would let the wiring agree with a table nobody runs.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const OTHER_TERMINAL = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
const SESSION = SessionId.fromString(SESSION_UUID);
const NEXT_SESSION = SessionId.fromString(NEXT_SESSION_UUID);
const THIRD_SESSION = SessionId.fromString('7c9e6679-7425-40de-944b-e07fc1f90ae7');

const NOW = new Date('2026-08-11T12:00:00.000Z');

const CONTEXT: Omit<HookEventContext, 'sessionId'> = {
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

function sessionStart(
  sessionId: SessionId,
  source: SessionStartSource = 'startup'
): SessionStartEvent {
  return { kind: 'SessionStart', sessionId, source, ...CONTEXT };
}

function sessionEnd(sessionId: SessionId): SessionEndEvent {
  return { kind: 'SessionEnd', sessionId, reason: 'clear', ...CONTEXT };
}

function userPromptSubmit(sessionId: SessionId): UserPromptSubmitEvent {
  return { kind: 'UserPromptSubmit', sessionId, userInput: 'go on', ...CONTEXT };
}

function preToolUse(sessionId: SessionId, toolName: string | null): PreToolUseEvent {
  return { kind: 'PreToolUse', sessionId, toolName, toolUseId: 'tu-1', ...CONTEXT };
}

function postToolUse(sessionId: SessionId, toolName: string | null): PostToolUseEvent {
  return { kind: 'PostToolUse', sessionId, toolName, toolUseId: 'tu-1', ...CONTEXT };
}

function permissionRequest(sessionId: SessionId, toolName: string | null): PermissionRequestEvent {
  return { kind: 'PermissionRequest', sessionId, toolName, permissionLevel: 'ask', ...CONTEXT };
}

function stop(sessionId: SessionId, lastAssistantMessage: string | null = null): StopEvent {
  return { kind: 'Stop', sessionId, lastAssistantMessage, ...CONTEXT };
}

function notification(sessionId: SessionId, notificationType: NotificationType): NotificationEvent {
  return { kind: 'Notification', sessionId, notificationType, message: null, ...CONTEXT };
}

function observedIn(state: PersistedTerminalState): ObservedState {
  return ObservedState.create({
    state,
    lastEventAt: new Date('2026-08-11T09:00:00.000Z'),
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

interface Stand {
  readonly registry: SessionRegistry;
  readonly logger: RecordingLogger;
  readonly clock: FixedClock;
  /** Changes about ONE record. The wholesale kind is collected separately, where it is the subject. */
  readonly changes: EntryChange[];
  readonly projections: number;
  /** Ids the registry said it had dropped, in order. */
  readonly removals: string[];
  /** Refusals published because the conversation was one this record never had. */
  readonly unknown: UnknownConversationChange[];
}

function stand(entry: TerminalEntry | null = makeEntry()): Stand {
  const logger = new RecordingLogger();
  const clock = new FixedClock(NOW);
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  if (entry !== null) {
    registry.register(entry);
  }
  const changes: EntryChange[] = [];
  const removals: string[] = [];
  const unknown: UnknownConversationChange[] = [];
  let projections = 0;
  // A total switch rather than an `else`: a fifth kind of change must arrive
  // here as a compiler error and not as a silently miscounted projection.
  registry.subscribe((change) => {
    switch (change.kind) {
      case 'entry':
        changes.push(change);
        return;
      case 'removed':
        removals.push(change.terminalId.value);
        return;
      case 'unknown-conversation':
        unknown.push(change);
        return;
      case 'projection':
        projections += 1;
        return;
    }
  });
  return {
    registry,
    logger,
    clock,
    changes,
    removals,
    unknown,
    get projections(): number {
      return projections;
    },
  };
}

/** The entry as the registry holds it now. Fails loudly rather than returning undefined. */
function current(registry: SessionRegistry, id: TerminalId = TERMINAL): TerminalEntry {
  const entry = registry.get(id);
  if (entry === undefined) {
    throw new Error(`the registry does not hold ${id.value}`);
  }
  return entry;
}

describe('SessionRegistry holds this window terminals', () => {
  it('knows a registered terminal and nothing else', () => {
    const { registry } = stand();
    expect(registry.knows(TERMINAL)).toBe(true);
    expect(registry.knows(OTHER_TERMINAL)).toBe(false);
  });

  it('lists what it holds', () => {
    const { registry } = stand();
    expect(registry.list().map((entry) => entry.terminalId.value)).toStrictEqual([TERMINAL_UUID]);
  });

  it('announces a registration, carrying the entry and no transition', () => {
    const { registry, changes } = stand(null);
    registry.register(makeEntry());

    expect(changes).toHaveLength(1);
    expect(changes[0]?.entry.terminalId.value).toBe(TERMINAL_UUID);
    expect(changes[0]?.transition).toBeNull();
  });

  it('says so when a registration replaces an entry it already held', () => {
    // Silently dropping the previous instance would discard its observed state
    // -- the state, the last message, the tool -- with nothing to read after.
    const { registry, logger } = stand();
    registry.register(makeEntry({ metadata: makeMetadata() }));

    expect(logger.infos.map((line) => line.message)).toContain(
      'a registration replaced an entry this window already held'
    );
  });

  it('answers the state of a terminal it holds, and null for one it does not', () => {
    // The lifecycle service asks this, and only this, when a terminal closes:
    // whether the record was still `launching` is what separates a failed
    // launch from an ordinary end.
    const { registry } = stand();

    expect(registry.stateOf(TERMINAL)).toBe('idle');
    expect(registry.stateOf(OTHER_TERMINAL)).toBeNull();
  });

  it('amends an entry it holds, and announces it as no movement', () => {
    // A change this window made to its own record -- `closedAt` (M1.12), a
    // rename (M2.7). Not an event, so nothing moved and nobody is interrupted.
    const { registry, changes } = stand(null);
    registry.register(makeEntry());
    const closed = makeEntry().withClosed(CREATED_AT);

    registry.amend(closed);

    expect(registry.get(TERMINAL)?.closedAt).toStrictEqual(CREATED_AT);
    expect(changes.at(-1)?.transition).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it('refuses to amend a terminal it does not hold', () => {
    // Where `register` would take it in, this one must not: amending is a
    // caller talking about a record that has already gone, and creating it back
    // would resurrect something this window stopped owning.
    const { registry, logger } = stand(null);

    registry.amend(makeEntry());

    expect(registry.list()).toStrictEqual([]);
    expect(logger.warnings.map((line) => line.message)).toStrictEqual([
      'an amendment named a terminal this window does not hold',
    ]);
  });

  it('stops calling a listener that unsubscribed', () => {
    // The listener RECORDS rather than throws. A throwing one proves nothing
    // here: `_notify` catches it by design, so a `dispose` that did nothing at
    // all would leave this test green -- which a mutant duly showed it did.
    const { registry } = stand();
    const heard: RegistryChange[] = [];
    const subscription = registry.subscribe((change) => {
      heard.push(change);
    });

    registry.ingest(TERMINAL, stop(SESSION));
    subscription.dispose();
    registry.ingest(TERMINAL, userPromptSubmit(SESSION));

    expect(heard).toHaveLength(1);
  });

  it('keeps going, and says so, when a listener throws', () => {
    // A listener is the tree view or a notifier. One of them failing to draw
    // must not stop the other from drawing, and must not read afterwards as if
    // the event had never arrived.
    const { registry, logger } = stand();
    const behind: RegistryChange[] = [];
    registry.subscribe(() => {
      throw new Error('the tree blew up');
    });
    registry.subscribe((change) => {
      behind.push(change);
    });

    expect(() => registry.ingest(TERMINAL, stop(SESSION))).not.toThrow();
    // The listener BEHIND the failing one still heard it.
    expect(behind).toHaveLength(1);
    expect(logger.errors.map((line) => line.message)).toContain(
      'a registry listener threw while being told of a change'
    );
  });
});

describe('SessionRegistry §4.6 case 1: an event for a terminal we do not hold', () => {
  it('is dropped rather than creating a record', () => {
    const { registry, logger } = stand(null);

    const outcome = registry.ingest(TERMINAL, stop(SESSION));

    expect(outcome.kind).toBe('unknown-terminal');
    expect(registry.list()).toHaveLength(0);
    expect(logger.warnings.map((line) => line.message)).toContain(
      'an event named a terminal this window does not hold'
    );
  });

  it('tells no listener', () => {
    const { registry, changes } = stand(null);
    registry.ingest(TERMINAL, stop(SESSION));
    expect(changes).toHaveLength(0);
  });

  it('drops an event addressed to another window terminal', () => {
    // `knows` already answers this on the request path, so the receiver never
    // gets here. It is checked anyway: a terminal can be dropped between the
    // two calls, and the answer must not depend on that race.
    const { registry } = stand();
    expect(registry.ingest(OTHER_TERMINAL, stop(SESSION)).kind).toBe('unknown-terminal');
  });
});

describe('SessionRegistry §4.6 case 2: the session id moved', () => {
  it('follows a /clear onto the new session and keeps the metadata', () => {
    const { registry } = stand(makeEntry({ observed: observedIn('ended') }));

    const outcome = registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));

    expect(outcome.kind).toBe('accepted');
    const entry = current(registry);
    expect(entry.sessionId.value).toBe(NEXT_SESSION_UUID);
    expect(entry.sessionIdHistory.map((past) => past.value)).toStrictEqual([SESSION_UUID]);
    // The whole point of separating the two identifiers: a new conversation
    // does not cost the human what they wrote about this terminal.
    expect(entry.metadata.displayName).toBe('auth-refactor');
    expect(entry.metadata.notes).toHaveLength(1);
  });

  it('comes back out of ended, so /clear does not strand the terminal', () => {
    const { registry } = stand(makeEntry({ observed: observedIn('ended') }));
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    expect(current(registry).observed.state).toBe('idle');
  });

  it('routes the whole /clear sequence, in the order the CLI emits it', () => {
    // SessionEnd carries the OLD id and arrives first; SessionStart carries the
    // new one. Getting this pair wrong is not a visible failure -- it is a
    // terminal that stays `ended` while the person is talking to it.
    const { registry } = stand();

    registry.ingest(TERMINAL, sessionEnd(SESSION));
    expect(current(registry).observed.state).toBe('ended');

    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    registry.ingest(TERMINAL, userPromptSubmit(NEXT_SESSION));

    const entry = current(registry);
    expect(entry.observed.state).toBe('working');
    expect(entry.sessionId.value).toBe(NEXT_SESSION_UUID);
  });

  it('follows a SessionStart whatever source it names', () => {
    // Wider than §4.6's `source: "clear"`, deliberately. `/resume` onto another
    // conversation, `--fork-session` and `/compact` all begin a session with a
    // new id under a different source, and `source` is a field we narrow to
    // `other` whenever we do not recognise it -- so a rule keyed on its value
    // would freeze the terminal on a label we failed to guess.
    for (const source of ['resume', 'compact', 'fork', 'other'] as const) {
      const { registry } = stand();
      registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, source));
      expect(current(registry).sessionId.value).toBe(NEXT_SESSION_UUID);
    }
  });

  it('does not rename on any event other than SessionStart', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, userPromptSubmit(NEXT_SESSION));
    expect(current(registry).sessionId.value).toBe(SESSION_UUID);
  });

  it('follows a SessionStart that names a session the terminal already used', () => {
    // A19, measured 2026-08-12: `/resume <id>` inside the terminal is announced
    // exactly like `/clear` -- `SessionEnd` and then `SessionStart` -- except
    // that the id it carries is one this terminal has already had. This record
    // used to stay on the conversation the person had just left, and a restore
    // would then have offered that one.
    const { registry, logger } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));

    const outcome = registry.ingest(TERMINAL, sessionStart(SESSION, 'resume'));

    expect(outcome.kind).toBe('accepted');
    expect(current(registry).sessionId.value).toBe(SESSION_UUID);
    expect(current(registry).sessionIdHistory.map((id) => id.value)).toStrictEqual([
      NEXT_SESSION_UUID,
    ]);
    expect(logger.warnings.map((line) => line.message)).not.toContain(
      'a terminal announced a session it had used before'
    );
    // Said in the log, because from the outside a rename to an id we have seen
    // before and a rename to a fresh one look identical, and only one of them
    // means the person went back.
    const renames = logger.infos.filter((line) => line.message === 'a terminal changed session');
    expect(renames.at(-1)?.details?.returning).toBe(true);
    // And the `/clear` that got it there was not a return, so the flag is
    // reporting the difference rather than being always on.
    expect(renames.at(0)?.details?.returning).toBe(false);
  });

  it('treats what it left as stale, whichever direction it moved', () => {
    // The other half of the swap. An event still in flight from the conversation
    // the terminal has just left belongs to this record -- and must not set its
    // state, or a `SessionEnd` from the abandoned session would end the one that
    // replaced it.
    const { registry } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    registry.ingest(TERMINAL, sessionStart(SESSION, 'resume'));

    expect(registry.ingest(TERMINAL, stop(NEXT_SESSION)).kind).toBe('stale-session');
  });
});

describe('SessionRegistry §4.6 case 3: an event from a session the terminal has left', () => {
  it('is not applied, and does not create a second record', () => {
    const { registry, logger } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    const before = current(registry);

    const outcome = registry.ingest(TERMINAL, stop(SESSION));

    expect(outcome.kind).toBe('stale-session');
    expect(registry.list()).toHaveLength(1);
    expect(current(registry)).toBe(before);
    expect(logger.warnings.map((line) => line.message)).toContain(
      'an event arrived from a session this terminal has left'
    );
  });

  it('cannot make a dead conversation say what the live one is doing', () => {
    // The reason the previous case is not simply "apply it to the same record".
    // A `SessionEnd` still in flight from the session `/clear` replaced would
    // otherwise kill the session that replaced it.
    const { registry } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    registry.ingest(TERMINAL, userPromptSubmit(NEXT_SESSION));

    registry.ingest(TERMINAL, sessionEnd(SESSION));

    expect(current(registry).observed.state).toBe('working');
  });

  it('refuses a session this terminal never had', () => {
    const { registry, logger } = stand();

    const outcome = registry.ingest(TERMINAL, stop(THIRD_SESSION));

    expect(outcome.kind).toBe('foreign-session');
    expect(current(registry).observed.state).toBe('idle');
    expect(logger.warnings.map((line) => line.message)).toContain(
      'an event named a session this terminal never had'
    );
  });

  it('checks the session id against the entry, never against the terminal id', () => {
    // The two are different identifiers by construction, so comparing the body
    // with the URL would be unequal ALWAYS rather than on drift -- every event
    // refused, every terminal frozen. Stated as a test because it is the exact
    // mistake §4.6 was written to prevent.
    const asTerminal = SessionId.fromString(TERMINAL_UUID);
    const { registry } = stand();

    expect(registry.ingest(TERMINAL, stop(SESSION)).kind).toBe('accepted');
    expect(registry.ingest(TERMINAL, stop(asTerminal)).kind).toBe('foreign-session');
  });

  it('tells no listener that a refused event changed the record', () => {
    const { registry, changes } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    changes.length = 0;

    registry.ingest(TERMINAL, stop(SESSION));
    registry.ingest(TERMINAL, stop(THIRD_SESSION));

    expect(changes).toHaveLength(0);
  });

  it('publishes the conversation it has never heard of, and not the one it remembers', () => {
    // The difference between the two refusals is the difference between traffic
    // and a defect. An event from a session in the history is the ordinary
    // in-flight case of a `/clear` that went well; an event from a session
    // nobody announced usually means the announcement was lost -- and only
    // somebody holding the record's state can tell that from a source we have
    // not measured, so the fact is published and the judgement is not made here
    // (M2.8).
    const { registry, unknown } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));

    registry.ingest(TERMINAL, stop(SESSION));
    registry.ingest(TERMINAL, stop(THIRD_SESSION));

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.sessionId.value).toBe(THIRD_SESSION.value);
  });

  it('hands over the record untouched, because nothing about it moved', () => {
    const { registry, unknown } = stand();

    registry.ingest(TERMINAL, stop(THIRD_SESSION));

    expect(unknown[0]?.entry).toBe(current(registry));
    expect(unknown[0]?.entry.sessionId.value).toBe(SESSION.value);
  });

  it('names the record in the log when a listener throws about that refusal', () => {
    const { registry, logger } = stand();
    registry.subscribe(() => {
      throw new Error('a listener that cannot cope');
    });

    registry.ingest(TERMINAL, stop(THIRD_SESSION));

    expect(logger.errors.at(-1)?.details?.terminalId).toBe(TERMINAL_UUID);
  });
});

describe('SessionRegistry applies what the state machine says', () => {
  it('moves the state and stamps the clock', () => {
    const { registry, clock } = stand();
    clock.advance(5000);

    const outcome = registry.ingest(TERMINAL, preToolUse(SESSION, 'Read'));

    expect(outcome.kind).toBe('accepted');
    const entry = current(registry);
    expect(entry.observed.state).toBe('working');
    expect(entry.observed.lastEventAt).toStrictEqual(new Date(NOW.getTime() + 5000));
  });

  it('hands the transition to its listeners, signal and all', () => {
    // The signal is the reason the listener gets the transition rather than a
    // bare "something changed": `launch_failed` and `ended` are the same target
    // state, and only the from-state tells them apart (§4.3). A listener that
    // diffed entries could not recover it.
    const { registry, changes } = stand(makeEntry({ observed: observedIn('launching') }));

    registry.ingest(TERMINAL, permissionRequest(SESSION, 'Bash'));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.transition).toStrictEqual({
      kind: 'moved',
      from: 'launching',
      to: 'waiting_permission',
      signal: 'waiting_permission',
    });
  });

  it('still records an event that leaves the state where it was', () => {
    const { registry, clock, changes } = stand();
    clock.advance(1000);

    const outcome = registry.ingest(TERMINAL, notification(SESSION, 'idle_prompt'));

    expect(outcome.kind).toBe('accepted');
    expect(current(registry).observed.lastEventAt).toStrictEqual(new Date(NOW.getTime() + 1000));
    expect(changes).toHaveLength(1);
  });

  it('leaves the entry untouched when the machine ignores the event', () => {
    // `ignored` is not `stayed`: the machine is saying it DROPPED something.
    // Moving `lastEventAt` for an event we refused would make "nothing has
    // happened here for ten minutes" unreadable.
    const { registry, logger, changes } = stand(makeEntry({ observed: observedIn('ended') }));
    const before = current(registry);

    const outcome = registry.ingest(TERMINAL, stop(SESSION));

    expect(outcome.kind).toBe('accepted');
    expect(current(registry)).toBe(before);
    expect(changes).toHaveLength(0);
    expect(logger.infos.map((line) => line.message)).toContain('an event was not applied');
  });

  it('takes a synthetic event, which carries no session id at all', () => {
    const { registry } = stand();
    expect(registry.ingest(TERMINAL, terminalClosed()).kind).toBe('accepted');
    expect(current(registry).observed.state).toBe('ended');
  });

  it('does not put a synthetic event through the session check', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    expect(registry.ingest(TERMINAL, processGone(4242)).kind).toBe('accepted');
    expect(current(registry).observed.state).toBe('orphaned');
  });
});

describe('SessionRegistry keeps the observed detail a person reads', () => {
  it('names the tool a turn is running', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, preToolUse(SESSION, 'Bash'));
    expect(current(registry).observed.currentTool).toBe('Bash');
  });

  it('names the tool that is waiting for permission', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, permissionRequest(SESSION, 'Bash'));
    expect(current(registry).observed.currentTool).toBe('Bash');
  });

  it('forgets the tool once it has finished', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, preToolUse(SESSION, 'Bash'));
    registry.ingest(TERMINAL, postToolUse(SESSION, 'Bash'));
    expect(current(registry).observed.currentTool).toBeNull();
  });

  it('forgets the tool when a turn ends', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, preToolUse(SESSION, 'Bash'));
    registry.ingest(TERMINAL, stop(SESSION));
    expect(current(registry).observed.currentTool).toBeNull();
  });

  it('says a tool is running without a name rather than naming the previous one', () => {
    // `PreToolUse` without `tool_name` still means a tool started. Keeping the
    // last one would put a finished tool on screen as the running one.
    const { registry } = stand();
    registry.ingest(TERMINAL, preToolUse(SESSION, 'Bash'));
    registry.ingest(TERMINAL, preToolUse(SESSION, null));
    expect(current(registry).observed.currentTool).toBeNull();
  });

  it('keeps the last assistant message from Stop', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, stop(SESSION, 'done, three files changed'));
    expect(current(registry).observed.lastAssistantMessage).toBe('done, three files changed');
  });

  it('does not erase the last message when a Stop arrives without one', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, stop(SESSION, 'done, three files changed'));
    registry.ingest(TERMINAL, stop(SESSION, null));
    expect(current(registry).observed.lastAssistantMessage).toBe('done, three files changed');
  });

  it('drops the previous conversation last message when a session begins', () => {
    const { registry } = stand();
    registry.ingest(TERMINAL, stop(SESSION, 'done, three files changed'));
    registry.ingest(TERMINAL, sessionStart(NEXT_SESSION, 'clear'));
    expect(current(registry).observed.lastAssistantMessage).toBeNull();
  });

  it('leaves the fields it has no source for alone', () => {
    // `cost` and `contextWindow` have exactly one producer, the statusline
    // forwarder (M1.8a), and `pid` comes from the gateway. A registry that reset
    // them on every event would make those channels look broken.
    //
    // The values are deliberately NOT the null the fixture starts with: against
    // a null baseline this test passes even for a registry that clears all
    // three, which is a test that cannot fail.
    const filled = ObservedState.create({
      state: 'working',
      lastEventAt: NOW,
      currentTool: null,
      lastAssistantMessage: null,
      cost: CostSnapshot.create(0.42, 90_000),
      contextWindow: ContextWindowSnapshot.create(37),
      pid: 4242,
    });
    const { registry } = stand(makeEntry({ observed: filled }));

    registry.ingest(TERMINAL, stop(SESSION));

    const after = current(registry).observed;
    expect(after.cost?.totalUsd).toBe(0.42);
    expect(after.contextWindow?.usedPercentage).toBe(37);
    expect(after.pid).toBe(4242);
  });
});

describe('SessionRegistry is the sink, and the only thing that reads a body', () => {
  function bodyFor(sessionId: SessionId, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId.value, ...extra });
  }

  function deliver(registry: SessionRegistry, raw: string, terminalId = TERMINAL): void {
    registry.receive({ terminalId, receivedAt: NOW, raw });
  }

  it('turns a body into a state change', () => {
    const { registry } = stand(makeEntry({ observed: observedIn('working') }));

    deliver(registry, bodyFor(SESSION, { last_assistant_message: 'all done' }));

    const entry = current(registry);
    expect(entry.observed.state).toBe('idle');
    expect(entry.observed.lastAssistantMessage).toBe('all done');
  });

  it('warns about a body that is not JSON, and applies nothing', () => {
    const { registry, logger, changes } = stand();

    deliver(registry, 'this is not json');

    expect(changes).toHaveLength(0);
    expect(logger.warnings.map((line) => line.message)).toContain('a hook payload could not be read');
  });

  it('warns about a JSON body that is not a hook payload', () => {
    const { registry, logger } = stand();
    deliver(registry, '{"hello":"world"}');
    expect(logger.warnings.map((line) => line.message)).toContain('a hook payload could not be read');
  });

  it('passes over an event type we do not model without calling it a failure', () => {
    // The CLI emits well over thirty; we model eleven. A warning per unmodelled
    // event would make the log useless exactly when it is needed.
    const { registry, logger, changes } = stand();

    deliver(registry, JSON.stringify({ hook_event_name: 'PreCompact', session_id: SESSION_UUID }));

    expect(changes).toHaveLength(0);
    expect(logger.warnings).toHaveLength(0);
    expect(logger.infos.map((line) => line.message)).toContain('a hook event we do not model');
  });

  it('never throws out of receive, whatever arrives', () => {
    // The receiver calls this after the response has gone. A throw here is
    // reported to nobody but the log, so it must not be how a body is refused.
    const { registry } = stand();
    for (const raw of ['', 'null', '[]', '{"hook_event_name":"Stop"}', '{"session_id":"nope"}']) {
      expect(() => {
        deliver(registry, raw);
      }).not.toThrow();
    }
  });

  it('drops a delivery for a terminal it does not hold', () => {
    const { registry, logger } = stand();
    deliver(registry, bodyFor(SESSION), OTHER_TERMINAL);
    expect(registry.list()).toHaveLength(1);
    expect(logger.warnings.map((line) => line.message)).toContain(
      'an event named a terminal this window does not hold'
    );
  });
});

/**
 * The other half of the projection, and the reason §4.6 calls the registry a
 * projection rather than a source: what other windows are doing arrives here
 * wholesale, from the base, and never becomes something this window may act on.
 */
describe('SessionRegistry projects what other windows own', () => {
  const FOREIGN = TerminalId.fromString('9d5f8e21-4a3b-4c6d-8e7f-0a1b2c3d4e5f');

  function foreignEntry(id: TerminalId = OTHER_TERMINAL): TerminalEntry {
    return makeEntry({ terminalId: id, owner: makeOwnerRef('another-window') });
  }

  it('lists them after our own, keeping the order they arrived in', () => {
    const { registry } = stand();

    registry.replaceForeign([foreignEntry(), foreignEntry(FOREIGN)]);

    expect(registry.list().map((entry) => entry.terminalId.value)).toStrictEqual([
      TERMINAL_UUID,
      OTHER_TERMINAL.value,
      FOREIGN.value,
    ]);
  });

  it('replaces the whole projection, so a record gone from the base goes from the list', () => {
    // The signal that brings us here carries no delta -- the file watcher can
    // lose a batch and say only that it lost one -- so "what is not in this
    // list is not there any more" is the only reading available.
    const { registry } = stand();
    registry.replaceForeign([foreignEntry(), foreignEntry(FOREIGN)]);

    registry.replaceForeign([foreignEntry(FOREIGN)]);

    expect(registry.list().map((entry) => entry.terminalId.value)).toStrictEqual([
      TERMINAL_UUID,
      FOREIGN.value,
    ]);
  });

  /*
   * What is in memory here is newer than what is on disk by however long the
   * write debounce is (M2.6). A base that overwrote our own record would show a
   * terminal a second behind its own window -- and the row would flicker
   * backwards on every re-read.
   */
  it('never overwrites a record this window holds, even when the base offers one', () => {
    const { registry } = stand();
    const stale = makeEntry({ observed: observedIn('launching') });

    registry.replaceForeign([stale]);

    expect(registry.get(TERMINAL)?.observed.state).toBe('idle');
    expect(registry.list()).toHaveLength(1);
  });

  it('drops the projected copy when this window takes the record on', () => {
    // Which is what adoption does every time it succeeds (M2.10). Two rows for
    // one terminal is the visible half; the invisible half is that one of them
    // can never be acted on.
    const { registry } = stand(null);
    registry.replaceForeign([foreignEntry()]);

    registry.register(makeEntry({ terminalId: OTHER_TERMINAL }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.knows(OTHER_TERMINAL)).toBe(true);
  });

  /*
   * The list a caller wants when it is about to OFFER something. Written as its
   * own method after the close picker was found offering another window's
   * terminals -- in a dialog that then waited for a choice this window could
   * not have acted on.
   */
  it('keeps a list of its own records for the callers that may act', () => {
    const { registry } = stand();
    registry.replaceForeign([foreignEntry()]);

    expect(registry.own().map((entry) => entry.terminalId.value)).toStrictEqual([TERMINAL_UUID]);
    expect(registry.list()).toHaveLength(2);
  });

  it('does not let a foreign record be acted on, looked up or amended', () => {
    // `get` is what every command resolves a row through, so answering here
    // would put "only the owning window may write" back into each of them.
    const { registry, logger } = stand(null);
    registry.replaceForeign([foreignEntry()]);

    expect(registry.get(OTHER_TERMINAL)).toBeUndefined();
    expect(registry.knows(OTHER_TERMINAL)).toBe(false);
    expect(registry.stateOf(OTHER_TERMINAL)).toBeNull();
    expect(registry.ingest(OTHER_TERMINAL, stop(SESSION))).toStrictEqual({
      kind: 'unknown-terminal',
    });
    registry.amend(foreignEntry());
    expect(logger.warnings.map((line) => line.message)).toContain(
      'an amendment named a terminal this window does not hold'
    );
  });

  it('announces the replacement as one wholesale change, not as an entry moving', () => {
    // The distinction is load-bearing: a notifier that read this as an entry
    // change would interrupt a person about another window's terminal, and the
    // silence watch would start a timer for one.
    const world = stand();

    world.registry.replaceForeign([foreignEntry(), foreignEntry(FOREIGN)]);

    expect(world.changes).toHaveLength(0);
    expect(world.projections).toBe(1);
  });

  it('names no terminal when a listener throws on the wholesale change', () => {
    // The tree is one of these listeners, and it redraws every row on this
    // signal. A log line that named some terminal anyway would send whoever
    // reads it to look at a record that had nothing to do with the failure.
    const { registry, logger } = stand();
    registry.subscribe(() => {
      throw new Error('the tree blew up mid-redraw');
    });

    expect(() => {
      registry.replaceForeign([foreignEntry()]);
    }).not.toThrow();
    expect(logger.errors.at(-1)?.details).toMatchObject({ terminalId: null });
  });

  it('announces an empty base too, because emptying the list is news', () => {
    const world = stand();
    world.registry.replaceForeign([foreignEntry()]);

    world.registry.replaceForeign([]);

    expect(world.projections).toBe(2);
    expect(world.registry.list().map((entry) => entry.terminalId.value)).toStrictEqual([
      TERMINAL_UUID,
    ]);
  });
});

describe('a record this window is told to forget', () => {
  it('leaves the list, and says which one left', () => {
    const { registry, changes, removals } = stand();
    changes.length = 0;

    registry.forget(TERMINAL);

    expect(registry.knows(TERMINAL)).toBe(false);
    expect(registry.get(TERMINAL)).toBeUndefined();
    expect(registry.own()).toStrictEqual([]);
    expect(registry.list()).toStrictEqual([]);
    expect(removals).toStrictEqual([TERMINAL_UUID]);
    // Not an entry change: there is no entry to draw.
    expect(changes).toStrictEqual([]);
  });

  it('takes its events with it, so nothing arrives for a record nobody holds', () => {
    const { registry } = stand();

    registry.forget(TERMINAL);

    expect(registry.ingest(TERMINAL, terminalClosed())).toStrictEqual({ kind: 'unknown-terminal' });
    expect(registry.stateOf(TERMINAL)).toBeNull();
  });

  it('refuses an id it does not hold, exactly as an amendment does', () => {
    const { registry, logger, removals } = stand();

    registry.forget(OTHER_TERMINAL);

    expect(removals).toStrictEqual([]);
    expect(logger.warnings.at(-1)?.message).toContain('does not hold');
    expect(logger.warnings.at(-1)?.details?.terminalId).toBe(OTHER_TERMINAL.value);
    // The one it does hold is untouched.
    expect(registry.knows(TERMINAL)).toBe(true);
  });

  it('does not reach into another window records', () => {
    // Deleting one would be a write into a file this window may not write.
    const { registry, removals } = stand();
    const foreign = makeEntry({
      terminalId: OTHER_TERMINAL,
      owner: makeOwnerRef('another-window'),
    });
    registry.replaceForeign([foreign]);

    registry.forget(OTHER_TERMINAL);

    expect(registry.list().map((entry) => entry.terminalId.value)).toContain(OTHER_TERMINAL.value);
    expect(removals).toStrictEqual([]);
  });

  it('is not undone by the next read of the base', () => {
    // `replaceForeign` skips ids this window holds, and a forgotten id is held
    // by nobody -- so the guard that keeps a deleted row from coming back as
    // somebody else's is in `BaseProjection`, and this is what it guards.
    const { registry } = stand();
    const ours = makeEntry();
    registry.forget(TERMINAL);

    registry.replaceForeign([ours]);

    expect(registry.list()).toHaveLength(1);
    expect(registry.knows(TERMINAL)).toBe(false);
  });

  it('names the record in the log when a listener throws about its removal', () => {
    const { registry, logger } = stand();
    registry.subscribe(() => {
      throw new Error('a listener that cannot cope');
    });

    registry.forget(TERMINAL);

    expect(logger.errors.at(-1)?.details?.terminalId).toBe(TERMINAL_UUID);
  });
});
