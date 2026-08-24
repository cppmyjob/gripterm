import {
  DEFAULT_SILENCE_MS,
  HookEventParser,
  ObservabilityWatch,
  ObservedState,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  terminalClosed,
  type WatchReport,
} from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import {
  NEXT_SESSION_UUID,
  OBSERVED_AT,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
} from '../helpers/domain-fixtures';

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const SILENCE_MS = 20_000;

interface Stand {
  readonly registry: SessionRegistry;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly said: WatchReport[];
  readonly watch: ObservabilityWatch;
}

function stand(): Stand {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  const scheduler = new FakeScheduler();
  const said: WatchReport[] = [];
  const watch = new ObservabilityWatch({
    registry,
    scheduler,
    logger,
    silenceMs: SILENCE_MS,
    announce: (report) => said.push(report),
  });
  return { registry, scheduler, logger, said, watch };
}

function launching(): ReturnType<typeof makeEntry> {
  return makeEntry({
    observed: ObservedState.create({
      state: 'launching',
      lastEventAt: OBSERVED_AT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }),
  });
}

/** A real hook body, taking the real path: the receiver hands the registry a string. */
function hookArrives(registry: SessionRegistry): void {
  registry.receive({
    terminalId: TERMINAL,
    receivedAt: OBSERVED_AT,
    raw: JSON.stringify({
      session_id: SESSION_UUID,
      hook_event_name: 'UserPromptSubmit',
      cwd: 'D:/Projects/foo',
    }),
  });
}

/**
 * The check that covers the causes we did not think of.
 *
 * Reading settings can only ever find the blockers we know the names of. A
 * terminal that has been running for twenty seconds and has sent nothing covers
 * a policy, a CLI whose contract moved, a dead forwarder, a firewall and our own
 * mistake in the settings file -- with one rule, which is why §4.7 makes this
 * the detector and the settings read merely the explanation.
 */
describe('noticing that a terminal is not being observed', () => {
  it('has a silence of its own when the caller names none', () => {
    // The composition root does not pass one, so the default is the value that
    // actually ships.
    const logger = new RecordingLogger();
    const registry = new SessionRegistry({
      stateMachine: new TerminalStateMachine(),
      reader: new HookEventParser(),
      clock: new FixedClock(OBSERVED_AT),
      logger,
    });
    const scheduler = new FakeScheduler();
    new ObservabilityWatch({ registry, scheduler, logger, announce: () => undefined });

    registry.register(launching());

    expect(scheduler.live[0]?.ms).toBe(DEFAULT_SILENCE_MS);
  });

  it('says nothing while the terminal is still within its silence', () => {
    const { registry, scheduler, said } = stand();

    registry.register(launching());

    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.ms).toBe(SILENCE_MS);
    expect(said).toEqual([]);
  });

  it('says so when the silence runs out', () => {
    const { registry, scheduler, said } = stand();
    registry.register(launching());

    scheduler.elapse();

    expect(said).toHaveLength(1);
    expect(said[0]?.entry.terminalId.value).toBe(TERMINAL_UUID);
    expect(said[0]).toMatchObject({ kind: 'silent', silenceMs: SILENCE_MS });
  });

  it('writes it to the log as well, because a toast is gone in five seconds', () => {
    const { registry, scheduler, logger } = stand();
    registry.register(launching());

    scheduler.elapse();

    expect(logger.warnings.map((line) => line.message)).toContain(
      'a terminal has been running without sending a single event'
    );
  });

  it('stops counting the moment an event arrives', () => {
    // The proof that observation works is an event, and there is no other.
    const { registry, scheduler, said } = stand();
    registry.register(launching());

    hookArrives(registry);

    expect(scheduler.live).toEqual([]);
    expect(said).toEqual([]);
  });

  it('does not start counting again after an event has arrived', () => {
    const { registry, scheduler, said } = stand();
    registry.register(launching());
    hookArrives(registry);

    registry.register(launching());

    expect(scheduler.live).toEqual([]);
    expect(said).toEqual([]);
  });

  it('says it once, not once per amendment', () => {
    const { registry, scheduler, said } = stand();
    registry.register(launching());
    scheduler.elapse();

    registry.amend(launching());

    expect(scheduler.live).toEqual([]);
    expect(said).toHaveLength(1);
  });

  it('keeps one timer for one terminal, however often the record is amended', () => {
    const { registry, scheduler } = stand();
    registry.register(launching());

    registry.amend(launching());

    expect(scheduler.live).toHaveLength(1);
  });

  it('leaves a terminal that never claimed to be starting alone', () => {
    // A record restored into the list without a process (M2) is not silent --
    // it is not running. Warning about it would train the person to ignore this.
    const { registry, scheduler } = stand();

    registry.register(makeEntry());

    expect(scheduler.armed).toEqual([]);
  });

  it('stops counting when the terminal dies, since a dead terminal owes us nothing', () => {
    const { registry, scheduler, said } = stand();
    registry.register(launching());

    registry.ingest(TERMINAL, terminalClosed());

    expect(scheduler.live).toEqual([]);
    expect(said).toEqual([]);
  });

  it('cancels what it is waiting for when the window goes', () => {
    // Deactivation is not a verdict about anybody's terminal, and a toast raised
    // by a disposed extension is worse than no toast.
    const { registry, scheduler, watch } = stand();
    registry.register(launching());

    watch.dispose();

    expect(scheduler.live).toEqual([]);
  });

  it('hears nothing more once it has been disposed', () => {
    const { registry, scheduler, watch } = stand();
    watch.dispose();

    registry.register(launching());

    expect(scheduler.armed).toEqual([]);
  });
});

/**
 * A record another window owns is that window's to watch, and it is watching.
 * Announcing "Gripterm is not seeing this terminal" about one would be true,
 * useless, and indistinguishable from the failure this class exists to report.
 */
describe('the silence of other windows is not ours to report', () => {
  it('starts no timer for a launching terminal that came from the base', () => {
    const { registry, scheduler } = stand();

    registry.replaceForeign([launching()]);

    expect(scheduler.armed).toEqual([]);
  });
});

describe('a terminal whose record the person deleted', () => {
  it('is not waited for any longer', () => {
    // Twenty seconds later there would be no row on screen to explain the
    // sentence, and the sentence would be about a terminal nobody is looking
    // for.
    const { registry, scheduler } = stand();
    registry.register(launching());
    expect(scheduler.live).toHaveLength(1);

    registry.forget(TERMINAL);

    expect(scheduler.live).toStrictEqual([]);
  });

  it('would be watched again if it ever came back, because nothing is remembered', () => {
    // The smaller of the two promises available here. Saying "this id is never
    // watched again" would be a claim about a record returning from the dead,
    // and nothing today can make it true or false.
    const { registry, scheduler } = stand();
    registry.register(launching());
    registry.forget(TERMINAL);

    registry.register(launching());

    expect(scheduler.live).toHaveLength(1);
  });
});

/**
 * The other way a terminal stops being observed, and the one this class's own
 * doc used to claim it caught while catching nothing of the sort: the silence
 * timer settles on a terminal's first event and never arms again, so a terminal
 * that goes wrong an hour later was watched by nobody.
 *
 * That hour-later failure is exactly M2.8's: `/clear` sends `ConversationEnded` over
 * HTTP and `ConversationStarted` through the command forwarder (H1), so a forwarder
 * that did not run leaves the record at a witnessed end while the person carries
 * on typing -- and every event of the new conversation is refused as belonging
 * to a session this terminal never had. The row says "ended" while the terminal
 * works, which is П1 brought back by the feature written to prevent it.
 */
describe('noticing that a terminal is answering a conversation we never saw begin', () => {
  const STRANGER = NEXT_SESSION_UUID;
  const THIRD_UUID = '7f4d2a1c-5b6e-4c8a-9d0f-1a2b3c4d5e6f';

  function inState(state: 'ended' | 'idle' | 'resume_failed'): ReturnType<typeof makeEntry> {
    return makeEntry({
      observed: ObservedState.create({
        state,
        lastEventAt: OBSERVED_AT,
        currentTool: null,
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      }),
    });
  }

  function hookFrom(registry: SessionRegistry, sessionId: string): void {
    registry.receive({
      terminalId: TERMINAL,
      receivedAt: OBSERVED_AT,
      raw: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: 'D:/Projects/foo',
      }),
    });
  }

  it('says so when the row claims the conversation is over and the terminal is talking', () => {
    const { registry, said } = stand();
    registry.register(inState('ended'));

    hookFrom(registry, STRANGER);

    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ kind: 'stranded' });
    expect(said[0]?.entry.terminalId.value).toBe(TERMINAL_UUID);
  });

  it('says so about a restore that failed as well, for the same reason', () => {
    // The two witnessed ends are one rule, and it is the state machine's --
    // `resume_failed` also means "we saw this conversation stop". Something
    // answering afterwards is the same contradiction, and a copy of the pair
    // kept here would be free to disagree with the machine about a third state.
    const { registry, said } = stand();
    registry.register(inState('resume_failed'));

    hookFrom(registry, STRANGER);

    expect(said).toHaveLength(1);
  });

  it('names the conversation, because it is the only handle anyone has on it', () => {
    const { registry, said } = stand();
    registry.register(inState('ended'));

    hookFrom(registry, STRANGER);

    expect(said[0]).toMatchObject({ sessionId: { value: STRANGER } });
  });

  it('writes it to the log as well, because a toast is gone in five seconds', () => {
    const { registry, logger } = stand();
    registry.register(inState('ended'));

    hookFrom(registry, STRANGER);

    expect(logger.warnings.map((line) => line.message)).toContain(
      'a terminal is answering a conversation this window never saw begin'
    );
  });

  it('says it once, and not once per keystroke', () => {
    // Everything the person types from here on arrives the same way. A toast
    // apiece would be the failure made unusable by its own report.
    const { registry, said } = stand();
    registry.register(inState('ended'));

    hookFrom(registry, STRANGER);
    hookFrom(registry, STRANGER);
    hookFrom(registry, STRANGER);

    expect(said).toHaveLength(1);
  });

  it('says it again when a second conversation goes missing', () => {
    // Another `/clear` with the forwarder still dead. The terminal is stranded
    // for a second time, on an id the person has not been given.
    const { registry, said } = stand();
    registry.register(inState('ended'));
    hookFrom(registry, STRANGER);

    hookFrom(registry, THIRD_UUID);

    expect(said).toHaveLength(2);
  });

  it('leaves alone a terminal whose row is not claiming to be over', () => {
    // An event from an unknown session while the record is alive is not this
    // failure, and may not be a failure at all -- a hook from somewhere in the
    // CLI we have not measured would arrive exactly like it. What makes the case
    // above safe to interrupt a person about is the state: the row says the
    // conversation ended, and something is plainly still talking.
    const { registry, said } = stand();
    registry.register(inState('idle'));

    hookFrom(registry, STRANGER);

    expect(said).toEqual([]);
  });

  it('leaves alone a late message from a conversation the record remembers', () => {
    // `/clear`, then the new conversation ends properly, and only then does a
    // message from the first one arrive. The record knows that id, so nothing
    // was missed -- this is the ordinary in-flight case of §4.6.
    const { registry, said } = stand();
    registry.register(
      makeEntry({
        sessionId: SessionId.fromString(NEXT_SESSION_UUID),
        sessionIdHistory: [SessionId.fromString(SESSION_UUID)],
        observed: inState('ended').observed,
      })
    );

    hookFrom(registry, SESSION_UUID);

    expect(said).toEqual([]);
  });

  it('forgets what it complained about when the record is deleted', () => {
    // Everything remembered about a record goes when the record goes. A restored
    // one is a new record to this class, and the person who has just been given
    // it back is owed the same warning as the first time.
    const { registry, said } = stand();
    registry.register(inState('ended'));
    hookFrom(registry, STRANGER);
    registry.forget(TERMINAL);

    registry.register(inState('ended'));
    hookFrom(registry, STRANGER);

    expect(said).toHaveLength(2);
  });
});
