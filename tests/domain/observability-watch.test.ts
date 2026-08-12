import {
  DEFAULT_SILENCE_MS,
  HookEventParser,
  ObservabilityWatch,
  ObservedState,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  terminalClosed,
  type SilentTerminal,
} from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { OBSERVED_AT, SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const SILENCE_MS = 20_000;

interface Stand {
  readonly registry: SessionRegistry;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly said: SilentTerminal[];
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
  const said: SilentTerminal[] = [];
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
    expect(said[0]?.silenceMs).toBe(SILENCE_MS);
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
