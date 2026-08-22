import {
  CONTEXT_OVER,
  ConflictError,
  HookEventParser,
  ListeningAddress,
  NotFoundError,
  ProcessLaunchStrategy,
  RestoreOrchestrator,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalLifecycleService,
  TerminalStateMachine,
  presentTerminal,
  type AdoptOptions,
  type AgentCommand,
  type AgentCommandFactory,
  type Disposable,
  type LaunchIntent,
  type OwnerRef,
  type RepositoryListener,
  type RestorePlan,
  type RestoreSkip,
  type TerminalEntry,
  type TerminalRepository,
} from '../../packages/core/src/index';
import { SESSION_UUID, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';
import {
  FakeScheduler,
  FixedClock,
  InMemoryTerminalGateway,
  RecordingLogger,
  SequentialIdGenerator,
} from '../helpers/port-fakes';

/**
 * What a restore is answerable for, and the cost that decides every rule below:
 * a terminal brought back wrongly is a second `claude --resume` on a live
 * conversation, and a terminal not brought back is a click. So the cases that
 * matter most here are the ones where something goes wrong between the plan and
 * the process -- the record moving under us, the start refusing, the resumed
 * process saying nothing at all.
 *
 * Driven through the real registry, the real state machine and the real
 * lifecycle service. Only two things are doubles: the base, because the
 * compare-and-swap it implements is `FileTerminalRepository`'s own test's
 * business (M2.3), and the agent's command factory, which is where the address
 * of an activation enters.
 */

const RESTORED_AT = new Date('2026-08-12T10:00:00.000Z');
const GONE = 'window-that-closed';
const SECOND_UUID = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const SECOND_SESSION = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const EXECUTABLE = 'C:/Users/x/.local/bin/claude.exe';

const FIRST_PORT = ListeningAddress.loopback(51_001);
const SECOND_PORT = ListeningAddress.loopback(62_002);

/**
 * The base as a restore meets it: records written by a window that is gone.
 *
 * `adopt` records what it was asked and hands back the entry under our name.
 * What it does NOT do is check anything -- the revision check, the liveness
 * check and the claim file are `FileTerminalRepository`'s, tested there against
 * a real directory. What this double is for is the pair of facts the
 * orchestrator is answerable for: WHICH revision it adopts at, and what it does
 * when the adoption is refused.
 */
class AbandonedBase implements TerminalRepository {
  public readonly adoptions: {
    readonly terminalId: string;
    readonly expected: number;
    readonly forced: boolean;
  }[] = [];
  /** Ids whose adoption fails -- what another window getting there first looks like. */
  public readonly contested = new Set<string>();

  private readonly _owner: OwnerRef;
  private readonly _entries = new Map<string, TerminalEntry>();

  constructor(owner: OwnerRef) {
    this._owner = owner;
  }

  public seed(entry: TerminalEntry): void {
    this._entries.set(entry.terminalId.value, entry);
  }

  public async adopt(
    id: TerminalId,
    expected: number,
    options: AdoptOptions = {}
  ): Promise<TerminalEntry> {
    this.adoptions.push({ terminalId: id.value, expected, forced: options.force === true });
    if (this.contested.has(id.value)) {
      throw new ConflictError('the entry moved while it was being adopted');
    }
    const entry = this._entries.get(id.value);
    if (entry === undefined) {
      throw new NotFoundError('no readable entry with that terminal id');
    }
    return entry.adoptedBy(this._owner);
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    return [...this._entries.values()];
  }

  public async readOwn(): Promise<readonly TerminalEntry[]> {
    return [];
  }

  public async write(): Promise<void> {
    // A restore writes through the registry and the writer (M2.6), never here.
  }

  public async remove(): Promise<void> {
    // Nothing in a restore deletes a record.
  }

  public watch(_listener: RepositoryListener): Disposable {
    return { dispose: (): void => undefined };
  }
}

/**
 * The agent's command factory, carrying the address of the activation that
 * built it.
 *
 * It exists for one claim -- that the command is built at START time and not
 * kept from a previous activation -- so the address it was constructed with
 * travels into the arguments, where a test can read it back.
 */
class AddressedCommands implements AgentCommandFactory {
  public readonly asked: { readonly terminalId: string, readonly intent: LaunchIntent }[] = [];
  public failure: Error | null = null;

  private readonly _address: ListeningAddress;

  constructor(address: ListeningAddress) {
    this._address = address;
  }

  public async commandFor(entry: TerminalEntry, intent: LaunchIntent): Promise<AgentCommand> {
    this.asked.push({ terminalId: entry.terminalId.value, intent });
    if (this.failure !== null) {
      throw this.failure;
    }
    return {
      executable: EXECUTABLE,
      // The shape of the real thing: a fresh settings file per start, named
      // after the port this activation is listening on (§4.4).
      args: ['--resume', entry.sessionId.value, '--settings', `${this._address.origin}/settings.json`],
      env: { GRIPTERM_TOKEN: 'secret' },
    };
  }
}

interface Stand {
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly registry: SessionRegistry;
  readonly gateway: InMemoryTerminalGateway;
  readonly commands: AddressedCommands;
  readonly lifecycle: TerminalLifecycleService;
  readonly base: AbandonedBase;
  readonly scheduler: FakeScheduler;
  readonly orchestrator: RestoreOrchestrator;
}

/** One activation of one window: everything below is born and dies with it. */
function stand(address: ListeningAddress = FIRST_PORT): Stand {
  const clock = new FixedClock(RESTORED_AT);
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  const gateway = new InMemoryTerminalGateway();
  const commands = new AddressedCommands(address);
  const owner = makeOwnerRef('this-window');
  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway,
    commands,
    strategy: new ProcessLaunchStrategy(),
    ids: new SequentialIdGenerator(),
    clock,
    owner,
    logger,
  });
  const base = new AbandonedBase(owner);
  const scheduler = new FakeScheduler();
  const orchestrator = new RestoreOrchestrator({
    repository: base,
    registry,
    lifecycle,
    scheduler,
    logger,
  });
  return { clock, logger, registry, gateway, commands, lifecycle, base, scheduler, orchestrator };
}

/** A record left behind by a window that is gone, already in the base. */
function abandoned(stand_: Stand, overrides: Parameters<typeof makeEntry>[0] = {}): TerminalEntry {
  const entry = makeEntry({ owner: makeOwnerRef(GONE), revision: 7, ...overrides });
  stand_.base.seed(entry);
  return entry;
}

function planFor(...entries: readonly TerminalEntry[]): RestorePlan {
  return {
    steps: entries.map((entry) => ({
      entry,
      expectedRevision: entry.revision,
      force: false,
      intent: 'resume' as const,
    })),
    skipped: [],
  };
}

/** A hook arriving from the resumed conversation. */
function announce(stand_: Stand, entry: TerminalEntry, source: 'resume' | 'startup' = 'resume'): void {
  stand_.registry.ingest(entry.terminalId, {
    kind: 'SessionStart',
    sessionId: entry.sessionId,
    source,
    promptId: null,
    cwd: null,
    transcriptPath: null,
  });
}

function stateOf(stand_: Stand, entry: TerminalEntry): string {
  return stand_.registry.get(entry.terminalId)?.observed.state ?? 'gone';
}

function shownWith(stand_: Stand, entry: TerminalEntry): readonly boolean[] {
  return stand_.gateway.handleFor(entry.terminalId).shownWith;
}

describe('carrying out a restore plan', () => {
  it('adopts at the revision the decision was made on, not at a fresher one', async () => {
    // The whole point of the compare-and-swap: between the plan and this call
    // another window may have adopted the same record. An orchestrator that
    // re-read the entry would pass the check exactly when it should have failed.
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run({
      steps: [{ entry, expectedRevision: 4, force: false, intent: 'resume' }],
      skipped: [],
    });

    expect(here.base.adoptions).toStrictEqual([
      { terminalId: entry.terminalId.value, expected: 4, forced: false },
    ]);
  });

  it('forces the adoption only for a step a person asked for', async () => {
    // `force` is what gets past an owner the store calls `unknown` -- a window
    // that is there and silent. Nothing but a person's demand may set it, so
    // this is the one place the flag can be seen to travel (M2.14).
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run({
      steps: [{ entry, expectedRevision: entry.revision, force: true, intent: 'resume' }],
      skipped: [],
    });

    expect(here.base.adoptions.map((one) => one.forced)).toStrictEqual([true]);
  });

  it('asks the agent for a restore when there is a conversation to continue', async () => {
    // `--session-id` naming a conversation the CLI already knows is refused by
    // its own validator, so a restore that asked for a launch on THIS record --
    // one with a transcript behind it -- would die at start every single time
    // (§4.4). The record with nothing behind it is the test below, and it comes
    // back carrying a new id precisely so that this rule is not broken.
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run(planFor(entry));

    expect(here.commands.asked).toStrictEqual([
      { terminalId: entry.terminalId.value, intent: 'resume' },
    ]);
  });

  it('brings a record whose conversation was never spoken in back in a NEW one', async () => {
    /*
     * The owner's decision of 2026-08-21, and the half of it that cannot be a
     * plain `--resume`: a conversation nothing was ever said in has no
     * transcript, and the CLI refuses to resume it. It also refuses
     * `--session-id` naming a conversation it already knows -- which is what the
     * test above is about -- so the record comes back carrying a NEW id, with
     * the old one moved into the history exactly as `/clear` moves it.
     */
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run({
      steps: [{ entry, expectedRevision: entry.revision, force: false, intent: 'launch' }],
      skipped: [],
    });

    expect(here.commands.asked).toStrictEqual([
      { terminalId: entry.terminalId.value, intent: 'launch' },
    ]);
    const back = here.registry.get(entry.terminalId);
    expect(back?.sessionId.value).not.toBe(entry.sessionId.value);
    expect(back?.sessionIdHistory.map((past) => past.value)).toStrictEqual([entry.sessionId.value]);
  });

  it('creates the terminal without taking the screen', async () => {
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run(planFor(entry));

    expect(shownWith(here, entry)).toStrictEqual([]);
  });

  it('leaves the record launching, so a non-zero exit reads as a failed restore', async () => {
    // The record arrives from the store wearing whatever it was doing when its
    // window died. Three rules downstream ask for `launching` and do nothing
    // without it (§4.3).
    const here = stand();
    const entry = abandoned(here);

    await here.orchestrator.run(planFor(entry));

    expect(stateOf(here, entry)).toBe('launching');
  });

  it('forgets the pid of a process from a previous life', async () => {
    // Windows hands pids out again aggressively. A restored record keeping the
    // old number would have the reconciler (M2.12) asking about a stranger.
    const here = stand();
    const entry = abandoned(here, {
      observed: makeEntry().observed,
    });

    await here.orchestrator.run(planFor(entry));

    expect(here.registry.get(entry.terminalId)?.observed.pid).toBeNull();
  });

  it('carries the steps out one at a time, in the order they were planned', async () => {
    const here = stand();
    const first = abandoned(here);
    const second = abandoned(here, {
      terminalId: TerminalId.fromString(SECOND_UUID),
      sessionId: SessionId.fromString(SECOND_SESSION),
    });

    await here.orchestrator.run(planFor(first, second));

    expect(here.base.adoptions.map((one) => one.terminalId)).toStrictEqual([
      first.terminalId.value,
      second.terminalId.value,
    ]);
    expect(here.gateway.specs.map((spec) => spec.terminalId.value)).toStrictEqual([
      first.terminalId.value,
      second.terminalId.value,
    ]);
  });

  it('counts what it started and passes the plan refusals through', async () => {
    const here = stand();
    const entry = abandoned(here);
    const skipped: RestoreSkip[] = [{ entry: makeEntry(), reason: 'foreign-folder' }];

    const report = await here.orchestrator.run({ ...planFor(entry), skipped });

    expect(report.started).toBe(1);
    expect(report.skipped).toStrictEqual(skipped);
    expect(report.attempts).toStrictEqual([
      {
        terminalId: entry.terminalId,
        displayName: entry.metadata.displayName,
        outcome: 'started',
        reason: null,
      },
    ]);
  });

  it('says why it brought nothing back, counted rather than one line per record', async () => {
    // A machine with several projects open refuses a terminal of every other
    // project. Forty copies of one sentence is a log nobody reads to the end.
    const here = stand();

    await here.orchestrator.run({
      steps: [],
      skipped: [
        { entry: makeEntry(), reason: 'foreign-folder' },
        { entry: makeEntry(), reason: 'foreign-folder' },
        { entry: makeEntry(), reason: 'owner-live' },
      ],
    });

    const line = here.logger.infos.find(
      (one) => one.message === 'records this window did not bring back, by reason'
    );
    expect(line?.details).toStrictEqual({ 'foreign-folder': 2, 'owner-live': 1 });
  });

  it('says nothing about refusals when there were none', async () => {
    const here = stand();

    await here.orchestrator.run({ steps: [], skipped: [] });

    expect(here.logger.infos.map((one) => one.message)).not.toContain(
      'records this window did not bring back, by reason'
    );
  });
});

describe('a record that moved while the plan was being carried out', () => {
  it('is left alone, and its neighbours still come back', async () => {
    const here = stand();
    const taken = abandoned(here);
    const mine = abandoned(here, {
      terminalId: TerminalId.fromString(SECOND_UUID),
      sessionId: SessionId.fromString(SECOND_SESSION),
    });
    here.base.contested.add(taken.terminalId.value);

    const report = await here.orchestrator.run(planFor(taken, mine));

    expect(report.started).toBe(1);
    expect(report.attempts.map((one) => one.outcome)).toStrictEqual(['contested', 'started']);
    expect(here.gateway.specs.map((spec) => spec.terminalId.value)).toStrictEqual([
      mine.terminalId.value,
    ]);
  });

  it('is not shouted about: another window adopting first is ordinary', async () => {
    const here = stand();
    const taken = abandoned(here);
    here.base.contested.add(taken.terminalId.value);

    await here.orchestrator.run(planFor(taken));

    expect(here.logger.warnings).toStrictEqual([]);
    expect(here.logger.errors).toStrictEqual([]);
  });

  it('carries the words the refusal came with', async () => {
    const here = stand();
    const taken = abandoned(here);
    here.base.contested.add(taken.terminalId.value);

    const report = await here.orchestrator.run(planFor(taken));

    expect(report.attempts[0]?.reason).toContain('moved while it was being adopted');
  });

  it('is not started when the record has gone from the base entirely', async () => {
    // A person deleted it between the plan and the step. `NotFoundError` rather
    // than `ConflictError`, and the answer is the same: not ours to start.
    const here = stand();
    const entry = makeEntry({ owner: makeOwnerRef(GONE) });

    const report = await here.orchestrator.run(planFor(entry));

    expect(report.attempts.map((one) => one.outcome)).toStrictEqual(['contested']);
    expect(here.gateway.specs).toStrictEqual([]);
  });
});

describe('a restored terminal that answers', () => {
  it('is shown without taking the focus, because nobody asked for it', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    announce(here, entry);

    expect(shownWith(here, entry)).toStrictEqual([true]);
  });

  it('never reaches degraded, because the wait was cancelled', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    announce(here, entry);

    expect(stateOf(here, entry)).toBe('idle');
    expect(here.scheduler.live).toStrictEqual([]);
  });

  it('is shown on ANY event, not on SessionStart alone', async () => {
    // On a machine with no `node` the `SessionStart` forwarder does not exist
    // (H1), so insisting on that one event would leave a perfectly good
    // conversation hidden for ever. A notification that names no phase is still
    // proof that the channel is there.
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.registry.ingest(entry.terminalId, {
      kind: 'Notification',
      notificationType: 'auth_success',
      message: null,
      sessionId: entry.sessionId,
      promptId: null,
      cwd: null,
      transcriptPath: null,
    });

    expect(shownWith(here, entry)).toStrictEqual([true]);
  });

  it('is shown once, however much it then says', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    announce(here, entry);
    here.registry.ingest(entry.terminalId, {
      kind: 'Stop',
      lastAssistantMessage: 'done',
      sessionId: entry.sessionId,
      promptId: null,
      cwd: null,
      transcriptPath: null,
    });

    expect(shownWith(here, entry)).toStrictEqual([true]);
  });

  it('leaves the terminals of other restores waiting', async () => {
    const here = stand();
    const first = abandoned(here);
    const second = abandoned(here, {
      terminalId: TerminalId.fromString(SECOND_UUID),
      sessionId: SessionId.fromString(SECOND_SESSION),
    });
    await here.orchestrator.run(planFor(first, second));

    announce(here, first);

    expect(shownWith(here, second)).toStrictEqual([]);
    expect(here.scheduler.live).toHaveLength(1);
  });
});

describe('a restore that fails at once', () => {
  it('ends in resume_failed, which is the state M2.13 offers to start over from', async () => {
    // `claude --resume <a conversation that is not there>` prints its refusal
    // and exits 1 in milliseconds [measured]. That is an exit code, not silence.
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.gateway.handleFor(entry.terminalId).close(1, 'process');

    expect(stateOf(here, entry)).toBe('resume_failed');
  });

  it('shows nothing, because there is no terminal left to show', async () => {
    // The empty `shownWith` alone proves nothing here -- the pane is gone, so a
    // reveal would be a no-op either way, and a test resting on that is the
    // vacuum kind. What separates "we did not try" from "we tried and there was
    // nothing there" is which line the orchestrator wrote.
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.gateway.handleFor(entry.terminalId).close(1, 'process');

    expect(shownWith(here, entry)).toStrictEqual([]);
    const said = here.logger.infos.map((one) => one.message);
    expect(said).toContain('a restored terminal ended before it said anything');
    expect(said).not.toContain('there was no terminal left to reveal');
  });

  it('takes the wait down with it, so nothing later says degraded', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.gateway.handleFor(entry.terminalId).close(1, 'process');

    expect(here.scheduler.live).toStrictEqual([]);
    expect(stateOf(here, entry)).toBe('resume_failed');
  });

  it('is the same when a person closes the terminal before it says anything', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.gateway.handleFor(entry.terminalId).close(undefined, 'user');

    expect(stateOf(here, entry)).toBe('ended');
    expect(shownWith(here, entry)).toStrictEqual([]);
    expect(here.scheduler.live).toStrictEqual([]);
  });
});

describe('a restored terminal that says nothing at all', () => {
  it('stops claiming to know what it is doing', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.scheduler.elapse();

    expect(stateOf(here, entry)).toBe('degraded');
  });

  it('is shown all the same: a running process with no pane is the silent failure', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.scheduler.elapse();

    expect(shownWith(here, entry)).toStrictEqual([true]);
  });

  it('is not killed, because nothing here says anything is wrong with it', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.scheduler.elapse();

    expect(here.gateway.handleFor(entry.terminalId).disposed).toBe(false);
  });

  it('comes back out of degraded when the event finally arrives', async () => {
    // The plan's own line: a late event takes `degraded` away. `ResumeTimedOut`
    // is an inference and a hook is first-hand evidence (§4.3).
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));
    here.scheduler.elapse();

    announce(here, entry);

    expect(stateOf(here, entry)).toBe('idle');
  });

  it('is not shown twice when that late event arrives', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));
    here.scheduler.elapse();

    announce(here, entry);

    expect(shownWith(here, entry)).toStrictEqual([true]);
  });

  it('says so in the log, with what it waited', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.scheduler.elapse();

    const line = here.logger.warnings.at(-1);
    expect(line?.message).toContain('has not said anything');
    expect(line?.details).toMatchObject({ terminalId: entry.terminalId.value, waitedMs: 20_000 });
  });

  it('waits as long as it was told to', async () => {
    const clockwork = stand();
    const entry = abandoned(clockwork);
    const orchestrator = new RestoreOrchestrator({
      repository: clockwork.base,
      registry: clockwork.registry,
      lifecycle: clockwork.lifecycle,
      scheduler: clockwork.scheduler,
      logger: clockwork.logger,
      resumeTimeoutMs: 500,
    });

    await orchestrator.run(planFor(entry));

    expect(clockwork.scheduler.live.map((timer) => timer.ms)).toStrictEqual([500]);
    orchestrator.dispose();
  });
});

describe('a restore whose terminal cannot be started at all', () => {
  it('keeps the record in this window, because it is ours now and cannot be given back', async () => {
    // Adoption moves ownership to a LIVE window by compare-and-swap, and there
    // is no operation for handing it to a dead one. A record owned by us and
    // held by nobody would vanish from every list on the machine.
    const here = stand();
    const entry = abandoned(here);
    here.commands.failure = new Error('no settings file');

    const report = await here.orchestrator.run(planFor(entry));

    expect(report.attempts.map((one) => one.outcome)).toStrictEqual(['unstartable']);
    expect(here.registry.knows(entry.terminalId)).toBe(true);
  });

  it('says the record has no process, so the row it leaves can be got rid of', async () => {
    /*
     * The customer, 2026-08-21 and again on the 22nd: rows that stay in the
     * list and cannot be deleted by any means.
     *
     * A record comes out of the store wearing the state its window died in.
     * `idle` -- the fixture's, and the commonest -- is a state
     * `presentTerminal` reads as a terminal this window can still act on, so
     * the row would offer Close, Rename and Focus and NOT Delete, would show no
     * green button to try the restore again, and would be refused by the
     * palette's Delete with "every terminal of this window is still running".
     * The only way out of it was to close a conversation that had never opened.
     *
     * Asserted through `presentTerminal` and `DISCARDABLE_ROWS` rather than on
     * the state alone, because the state is not what the person meets: the
     * `contextValue` is what every menu in the manifest is keyed on.
     */
    const here = stand();
    const entry = abandoned(here);
    expect(entry.observed.state).toBe('idle');
    here.commands.failure = new Error('no settings file');

    await here.orchestrator.run(planFor(entry));

    const left = here.registry.get(entry.terminalId);
    expect(left?.observed.state).toBe('orphaned');
    const shown = presentTerminal(left as TerminalEntry);
    expect(shown.contextValue).toBe(CONTEXT_OVER);
    // And still worth offering back: `orphaned` keeps the record restorable, so
    // the green button is on the row rather than gone with the failure.
    expect(left?.isRestorable()).toBe(true);
  });

  it('leaves no wait armed for a terminal that does not exist', async () => {
    const here = stand();
    const entry = abandoned(here);
    here.commands.failure = new Error('no settings file');

    await here.orchestrator.run(planFor(entry));

    expect(here.scheduler.live).toStrictEqual([]);
  });

  it('is ours to report, so it is an error and not a note', async () => {
    const here = stand();
    const entry = abandoned(here);
    here.commands.failure = new Error('no settings file');

    await here.orchestrator.run(planFor(entry));

    expect(here.logger.errors.at(-1)?.message).toContain('could not be started');
  });

  it('is not left waiting for an event that has nothing to arrive from', async () => {
    // The reconciler (M2.12) will ingest `ProcessGone` for records like this
    // one, and a restore still marked as waiting would answer by trying to
    // reveal a terminal that was never created.
    const here = stand();
    const entry = abandoned(here);
    here.commands.failure = new Error('no settings file');
    await here.orchestrator.run(planFor(entry));

    here.registry.ingest(entry.terminalId, { kind: 'ProcessGone', pid: null });

    expect(here.logger.infos.map((one) => one.message)).not.toContain(
      'there was no terminal left to reveal'
    );
  });
});

describe('the settings file of a restore belongs to the activation doing it', () => {
  it('reaches idle rather than degraded after the port has changed', async () => {
    // The invariant of §4.4, from the failure side: `settings.json` is a derived
    // artefact, regenerated under THIS activation's address before every start.
    // Reuse the file a previous activation wrote and every restored terminal
    // works perfectly, posts its events to a port nobody is listening on -- a
    // failed hook is non-blocking -- and reaches `degraded` together.
    const first = stand(FIRST_PORT);
    const entry = abandoned(first, { revision: 2 });

    const second = stand(SECOND_PORT);
    second.base.seed(entry);
    await second.orchestrator.run(planFor(entry));
    announce(second, entry);

    expect(second.gateway.specs[0]?.shellArgs).toContain(`${SECOND_PORT.origin}/settings.json`);
    expect(stateOf(second, entry)).toBe('idle');
    expect(second.scheduler.live).toStrictEqual([]);
  });
});

describe('a restore settled before its start returned', () => {
  it('is not armed afterwards, so nothing times out a terminal that has answered', async () => {
    // Reachable only through a listener that ingests an event the moment the
    // record is registered, which is inside `start`. Contrived, and the rule it
    // pins is not: a wait that is over must not be armed by the code that was
    // starting it.
    const here = stand();
    const entry = abandoned(here);
    const subscription = here.registry.subscribe((change) => {
      if (change.kind === 'entry' && change.transition === null) {
        subscription.dispose();
        announce(here, entry);
      }
    });

    await here.orchestrator.run(planFor(entry));

    expect(here.scheduler.live).toStrictEqual([]);
    expect(stateOf(here, entry)).toBe('idle');
  });
});

describe('a window that goes while a restore is waiting', () => {
  it('stops listening, so a late event reveals nothing', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.orchestrator.dispose();
    announce(here, entry);

    expect(shownWith(here, entry)).toStrictEqual([]);
  });

  it('cancels the waits it was holding', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));

    here.orchestrator.dispose();

    expect(here.scheduler.live).toStrictEqual([]);
  });
});

describe('an event about a terminal no restore is waiting for', () => {
  it('is nobody else\'s business', async () => {
    const here = stand();
    const entry = abandoned(here);
    await here.orchestrator.run(planFor(entry));
    announce(here, entry);

    // A second terminal this window simply owns, with no restore behind it.
    const other = await here.lifecycle.launch({
      displayName: 'a new one',
      recipe: makeEntry().launch,
    });
    here.registry.ingest(other.terminalId, {
      kind: 'Stop',
      lastAssistantMessage: null,
      sessionId: other.sessionId,
      promptId: null,
      cwd: null,
      transcriptPath: null,
    });

    // Shown once by its own launch, and never by the orchestrator.
    expect(here.gateway.handleFor(other.terminalId).shownWith).toStrictEqual([false]);
    expect(TERMINAL_UUID).not.toBe(SECOND_UUID);
    expect(SESSION_UUID).not.toBe(SECOND_SESSION);
  });
});
