import {
  ConflictError,
  HookEventParser,
  ObservedState,
  ProcessLaunchStrategy,
  SessionRegistry,
  ShellLaunchStrategy,
  TerminalId,
  TerminalLifecycleService,
  TerminalStateMachine,
  exitVerdict,
  type AgentCommand,
  type AgentCommandFactory,
  type LaunchIntent,
  type LaunchRequest,
  type LaunchStrategy,
  type RegistryChange,
  type TerminalEntry,
  type TerminalExitReason,
  type TerminalGateway,
  type TerminalHandle,
  type TerminalSpec,
} from '../../packages/core/src/index';
import { makeEntry, makeOwnerRef, makeRecipe } from '../helpers/domain-fixtures';
import {
  FixedClock,
  InMemoryTerminalGateway,
  RecordingLogger,
  SequentialIdGenerator,
} from '../helpers/port-fakes';

/**
 * The service is driven through its real registry and its real state machine
 * everywhere below, because the two questions it exists to answer -- "what does
 * a closing terminal mean" and "what is `closedAt` for" -- are both about the
 * record that results, not about the calls it made.
 *
 * The exit-code cases are the substance. A terminal that dies is reported by the
 * editor in exactly one shape whether the process failed, the person closed it
 * or we destroyed it ourselves (A15, measured 2026-08-11), so every distinction
 * below is drawn from something this service knew BEFORE the terminal closed.
 */

const STARTED_AT = new Date('2026-08-11T12:00:00.000Z');

/** A terminal id no stand ever produces. */
const ABSENT = '11111111-2222-4333-8444-555555555555';
const EXECUTABLE = 'C:/Users/x/.local/bin/claude.exe';

/** Both measured under `IPty.kill()` on 2026-08-17 (M3.2 stage B, §2). */
const CLAUDE_UNDER_KILL = 1;
const SHELL_UNDER_KILL = -1073741510;

class StubAgentCommands implements AgentCommandFactory {
  public readonly asked: { readonly terminalId: string, readonly intent: LaunchIntent }[] = [];
  public failure: Error | null = null;

  public async commandFor(entry: TerminalEntry, intent: LaunchIntent): Promise<AgentCommand> {
    this.asked.push({ terminalId: entry.terminalId.value, intent });
    if (this.failure !== null) {
      throw this.failure;
    }
    return {
      executable: EXECUTABLE,
      args: ['--session-id', entry.sessionId.value],
      env: { GRIPTERM_TOKEN: 'secret' },
    };
  }
}

/** The editor refusing to open a terminal at all -- a bad cwd, an exhausted handle table. */
class RefusingGateway implements TerminalGateway {
  public readonly engine = 'editor';

  public async create(_spec: TerminalSpec): Promise<TerminalHandle> {
    throw new Error('the editor refused');
  }

  public listKnown(): readonly TerminalHandle[] {
    return [];
  }

  /** Nothing was ever created, so there is nothing to hand back. */
  public handleFor(_terminalId: TerminalId): undefined {
    return undefined;
  }
}

interface Stand {
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly registry: SessionRegistry;
  readonly gateway: InMemoryTerminalGateway;
  readonly commands: StubAgentCommands;
  readonly lifecycle: TerminalLifecycleService;
}

function stand(strategy: LaunchStrategy = new ProcessLaunchStrategy()): Stand {
  const clock = new FixedClock(STARTED_AT);
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  const gateway = new InMemoryTerminalGateway();
  const commands = new StubAgentCommands();
  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway,
    commands,
    strategy,
    ids: new SequentialIdGenerator(),
    clock,
    owner: makeOwnerRef(),
    logger,
  });
  return { clock, logger, registry, gateway, commands, lifecycle };
}

/**
 * Lets the promises the service did not await finish.
 *
 * `start` does not wait for the editor to say which process it spawned -- a
 * platform that never answered would otherwise hold up every restore -- so the
 * pid arrives after the call returns, and a test has to give it that moment.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function request(displayName = 'auth-refactor'): LaunchRequest {
  return { displayName, recipe: makeRecipe() };
}

/** Every change the registry announced, in order, as the two facts each case is about. */
function trail(registry: SessionRegistry): { readonly closed: boolean, readonly state: string }[] {
  const seen: { closed: boolean, state: string }[] = [];
  registry.subscribe((change: RegistryChange) => {
    if (change.kind === 'entry') {
      seen.push({ closed: change.entry.closedAt !== null, state: change.entry.observed.state });
    }
  });
  return seen;
}

/**
 * The event the service produced for each close, in order.
 *
 * Read from the log rather than from a spy, because the log line is a shipped
 * artefact: it is what somebody reads when a terminal ended and nobody knows
 * why. Two rules are invisible in the resulting STATE and visible only here --
 * a late failure is an ordinary end, and one close produces one event.
 */
function closeEvents(logger: RecordingLogger): unknown[] {
  return logger.infos
    .filter((line) => line.message === 'a terminal closed')
    .map((line) => line.details?.event);
}

function signals(registry: SessionRegistry): string[] {
  const seen: string[] = [];
  registry.subscribe((change: RegistryChange) => {
    if (change.kind === 'entry' && change.transition?.kind === 'moved') {
      seen.push(change.transition.signal);
    }
  });
  return seen;
}

describe('TerminalLifecycleService starts a terminal', () => {
  it('puts the record in the list only once the terminal exists', async () => {
    const { lifecycle, registry } = stand();

    const entry = await lifecycle.launch(request());

    expect(registry.list()).toHaveLength(1);
    expect(registry.get(entry.terminalId)?.observed.state).toBe('launching');
  });

  it('gives the terminal and the conversation different ids', async () => {
    // `--session-id` is us telling the CLI which conversation this is, so the
    // record and the process agree on it before the process exists -- and the
    // two identifiers are separate by construction (§4.6).
    const { lifecycle } = stand();

    const entry = await lifecycle.launch(request());

    expect(entry.sessionId.value).not.toBe(entry.terminalId.value);
  });

  it('hands the editor what the strategy planned', async () => {
    const { lifecycle, gateway } = stand();

    const entry = await lifecycle.launch(request());

    expect(gateway.specs).toStrictEqual([
      {
        terminalId: entry.terminalId,
        name: 'auth-refactor',
        cwd: 'D:/Projects/foo',
        env: { GRIPTERM_TOKEN: 'secret' },
        shellPath: EXECUTABLE,
        shellArgs: ['--session-id', entry.sessionId.value],
      },
    ]);
  });

  it('asks the agent for a launch, not a restore', async () => {
    const { lifecycle, commands } = stand();

    const entry = await lifecycle.launch(request());

    expect(commands.asked).toStrictEqual([{ terminalId: entry.terminalId.value, intent: 'launch' }]);
  });

  it('takes the focus, because somebody asked for a terminal', async () => {
    const { lifecycle, gateway } = stand();

    const entry = await lifecycle.launch(request());

    expect(gateway.handleFor(entry.terminalId).shownWith).toStrictEqual([false]);
  });

  it('types nothing when the agent IS the terminal process', async () => {
    const { lifecycle, gateway } = stand();
    const handle = gateway.handleFor((await lifecycle.launch(request())).terminalId);

    expect(handle.sent).toStrictEqual([]);
    expect(handle.launched).toStrictEqual([]);
  });

  it('runs the command line as a launch when a shell is underneath', async () => {
    const { lifecycle, gateway } = stand(new ShellLaunchStrategy('powershell'));

    const entry = await lifecycle.launch(request());
    const handle = gateway.handleFor(entry.terminalId);

    expect(handle.launched).toHaveLength(1);
    expect(handle.launched[0]).toContain(EXECUTABLE);
    /*
     * And NOT through the plain typing path. The difference is the promise
     * M2.25 rests on: a launch line waits for the shell to be the person's own,
     * while `sendText` is for a terminal that is already the agent's. Measured
     * 2026-08-14 -- with the launch typed on creation, another extension's own
     * line arrived second and landed in the agent's prompt.
     */
    expect(handle.sent).toStrictEqual([]);
  });

  it('stamps the record with the clock, not with a second source of now', async () => {
    const { lifecycle } = stand();

    const entry = await lifecycle.launch(request());

    expect(entry.createdAt).toStrictEqual(STARTED_AT);
    expect(entry.observed.lastEventAt).toStrictEqual(STARTED_AT);
    expect(entry.closedAt).toBeNull();
  });

  it('leaves no record behind when the agent command cannot be built', async () => {
    // A settings file that could not be written, an executable that is gone.
    // A row stuck in `launching` for the life of the window would be worse than
    // the error the caller is about to show.
    const { lifecycle, registry, commands } = stand();
    commands.failure = new Error('no settings file');

    await expect(lifecycle.launch(request())).rejects.toThrow('no settings file');

    expect(registry.list()).toStrictEqual([]);
  });

  it('leaves no record behind when the editor refuses the terminal', async () => {
    const clock = new FixedClock(STARTED_AT);
    const logger = new RecordingLogger();
    const registry = new SessionRegistry({
      stateMachine: new TerminalStateMachine(),
      reader: new HookEventParser(),
      clock,
      logger,
    });
    const lifecycle = new TerminalLifecycleService({
      registry,
      gateway: new RefusingGateway(),
      commands: new StubAgentCommands(),
      strategy: new ProcessLaunchStrategy(),
      ids: new SequentialIdGenerator(),
      clock,
      owner: makeOwnerRef(),
      logger,
    });

    await expect(lifecycle.launch(request())).rejects.toThrow('the editor refused');

    expect(registry.list()).toStrictEqual([]);
  });

  it('refuses to start one conversation twice', async () => {
    // Two processes on one conversation is the failure the whole ownership
    // design exists to prevent; inside one window it is cheap to refuse.
    const { lifecycle, gateway } = stand();
    const entry = await lifecycle.launch(request());

    await expect(lifecycle.start(entry, 'launch')).rejects.toBeInstanceOf(ConflictError);

    expect(gateway.specs).toHaveLength(1);
  });

  it('carries a restore through the same path', async () => {
    const { lifecycle, commands, gateway } = stand();
    const entry = await lifecycle.launch(request());
    gateway.handleFor(entry.terminalId).close(undefined, 'shutdown');

    await lifecycle.start(entry, 'resume');

    expect(commands.asked.at(-1)).toStrictEqual({
      terminalId: entry.terminalId.value,
      intent: 'resume',
    });
    expect(gateway.specs).toHaveLength(2);
  });
});

describe('the pid of the process the editor started', () => {
  /**
   * П2 rests on this, and until 2026-08-13 nothing produced it.
   *
   * `mayBeRunning` (the restore predicate) reads a record with no pid as one
   * whose `claude` may still be running, and refuses to bring it back --
   * correctly, because "we have no evidence" is not "it is gone". The
   * consequence went unnoticed for the whole of M2: EVERY record had a null pid,
   * so every automatic restore was refused with `session-running`, and the
   * acceptance run of M2.16 is what found it.
   *
   * The source is the editor itself, which knows the process it spawned. The
   * hook environment carries the CLI's own pid too (A16), but only a command
   * hook sees it -- one event, one channel, and nothing at all for a terminal
   * whose session never announced itself.
   */
  it('is written onto the record, because the restore predicate has nothing else to ask', async () => {
    const { lifecycle, gateway, registry } = stand();
    gateway.pid = 4242;

    const entry = await lifecycle.launch(request());
    await flush();

    expect(registry.get(entry.terminalId)?.observed.pid).toBe(4242);
  });

  it('leaves the record alone when the platform does not know it', async () => {
    // `processId` resolves to `undefined` for a terminal whose process never
    // came up. Writing a zero or a guess here would be worse than the null: the
    // predicate would read it as a pid and ask whether a stranger is alive.
    const { lifecycle, gateway, registry } = stand();
    gateway.pid = null;

    const entry = await lifecycle.launch(request());
    await flush();

    expect(registry.get(entry.terminalId)?.observed.pid).toBeNull();
  });

  it('says so in the log when there is no pid to be had', async () => {
    const { lifecycle, gateway, logger } = stand();
    gateway.pid = null;

    await lifecycle.launch(request());
    await flush();

    expect(logger.infos.map((line) => line.message)).toContain(
      'the editor did not say which process the terminal is running'
    );
  });

  it('touches nothing but the pid, however far the record has moved by then', async () => {
    // The pid arrives asynchronously, and a hook can beat it: the terminal is
    // already `idle` when the editor answers. Writing back the record this
    // method remembers would put `launching` on it again.
    const { lifecycle, gateway, registry } = stand();
    gateway.pid = 77;
    gateway.holdPid();

    const entry = await lifecycle.launch(request());
    registry.ingest(entry.terminalId, {
      kind: 'SessionStart',
      sessionId: entry.sessionId,
      source: 'startup',
      promptId: null,
      cwd: null,
      transcriptPath: null,
    });
    gateway.releasePid();
    await flush();

    const held = registry.get(entry.terminalId);
    expect(held?.observed.state).toBe('idle');
    expect(held?.observed.pid).toBe(77);
  });

  it('does not resurrect a record this window no longer holds', async () => {
    // The person deleted the row while the editor was still answering. `amend`
    // would refuse it with a warning; the point of the check is that the warning
    // never happens, because nothing here is amiss.
    const { lifecycle, gateway, registry, logger } = stand();
    gateway.pid = 99;
    gateway.holdPid();

    const entry = await lifecycle.launch(request());
    registry.forget(entry.terminalId);
    gateway.releasePid();
    await flush();

    expect(registry.knows(entry.terminalId)).toBe(false);
    expect(logger.warnings).toStrictEqual([]);
  });
});

describe('TerminalLifecycleService starts a terminal nobody asked for', () => {
  /** A record as a restore finds it in the store: mid-turn, from a window that is gone. */
  function midTurn(): TerminalEntry {
    return makeEntry({
      observed: ObservedState.create({
        state: 'working',
        lastEventAt: new Date(STARTED_AT.getTime() - 3_600_000),
        currentTool: 'Bash',
        lastAssistantMessage: 'I will read the file first',
        cost: null,
        contextWindow: null,
        pid: 4242,
      }),
    });
  }

  it('leaves the screen alone when it was told to', async () => {
    // A window coming back with five terminals would otherwise open five panes
    // and leave the cursor in whichever one answered last (M2.11).
    const { lifecycle, gateway } = stand();
    const entry = midTurn();

    await lifecycle.start(entry, 'resume', 'hidden');

    expect(gateway.handleFor(entry.terminalId).shownWith).toStrictEqual([]);
  });

  it('says which it did, because the log is where a missing pane is explained', async () => {
    const { lifecycle, logger } = stand();

    await lifecycle.start(midTurn(), 'resume', 'hidden');

    // By its message rather than by its position: since M2.16 the pid of the
    // process the editor started arrives on its own schedule and writes a line
    // of its own, and a test that meant "the start" while saying "the last one"
    // would fail for a reason that has nothing to do with what it checks.
    const started = logger.infos.find((line) => line.message === 'a terminal was started');
    expect(started?.details).toMatchObject({ intent: 'resume', visibility: 'hidden' });
  });

  it('stamps the record launching, whatever it was doing when its window died', async () => {
    // Without this a non-zero exit would read as an ordinary end rather than a
    // failed restore, the resume timeout would not apply, and the silence watch
    // would not arm -- three rules, all of them silent when they fail (§4.3).
    const { lifecycle, registry } = stand();
    const entry = midTurn();

    await lifecycle.start(entry, 'resume', 'hidden');

    const started = registry.get(entry.terminalId);
    expect(started?.observed.state).toBe('launching');
    expect(started?.observed.lastEventAt).toStrictEqual(STARTED_AT);
    expect(started?.observed.currentTool).toBeNull();
    expect(started?.observed.pid).toBeNull();
  });

  it('hands the caller the record it registered, not the one it was given', async () => {
    // The orchestrator writes what comes back, so a stale instance here would
    // put the pre-restore state back on the disk a moment later.
    const { lifecycle, registry } = stand();

    const started = await lifecycle.start(midTurn(), 'resume', 'hidden');

    expect(registry.get(started.terminalId)).toBe(started);
  });
});

describe('TerminalLifecycleService reveals a terminal', () => {
  it('shows it without taking the focus, because nobody asked to be taken there', async () => {
    const { lifecycle, gateway } = stand();
    const entry = await lifecycle.start(makeEntry(), 'resume', 'hidden');

    lifecycle.reveal(entry.terminalId);

    expect(gateway.handleFor(entry.terminalId).shownWith).toStrictEqual([true]);
  });

  it('says so and does nothing when the terminal has already gone', async () => {
    // Between a restore starting and its first event, `--resume` can fail and
    // take the pane with it. Not an error: there is nothing left to show.
    const { lifecycle, logger, gateway } = stand();
    const entry = await lifecycle.start(makeEntry(), 'resume', 'hidden');
    gateway.handleFor(entry.terminalId).close(1, 'process');

    lifecycle.reveal(entry.terminalId);

    expect(gateway.handleFor(entry.terminalId).shownWith).toStrictEqual([]);
    expect(logger.infos.at(-1)?.message).toContain('no terminal left to reveal');
    expect(logger.warnings).toStrictEqual([]);
  });
});

describe('TerminalLifecycleService closes a terminal', () => {
  it('is the only thing that ever sets closedAt', async () => {
    const { lifecycle, registry, clock } = stand();
    const entry = await lifecycle.launch(request());
    clock.advance(60_000);

    lifecycle.close(entry.terminalId);

    expect(registry.get(entry.terminalId)?.closedAt).toStrictEqual(
      new Date(STARTED_AT.getTime() + 60_000)
    );
  });

  it('destroys the terminal and ends the record', async () => {
    const { lifecycle, registry, gateway } = stand();
    const entry = await lifecycle.launch(request());

    lifecycle.close(entry.terminalId);

    expect(gateway.handleFor(entry.terminalId).disposed).toBe(true);
    expect(registry.get(entry.terminalId)?.observed.state).toBe('ended');
  });

  it('closes the record before announcing that it ended', async () => {
    // Persistence subscribes here (M2). Announcing the end first would make one
    // act arrive as two, the first of which describes a terminal that is over
    // and still restorable.
    const { lifecycle, registry } = stand();
    const entry = await lifecycle.launch(request());
    const seen = trail(registry);

    lifecycle.close(entry.terminalId);

    expect(seen).toStrictEqual([
      { closed: true, state: 'launching' },
      { closed: true, state: 'ended' },
    ]);
  });

  it('keeps the first closing time when asked twice', async () => {
    const { lifecycle, registry, clock } = stand();
    const entry = await lifecycle.launch(request());
    lifecycle.close(entry.terminalId);
    clock.advance(60_000);

    lifecycle.close(entry.terminalId);

    expect(registry.get(entry.terminalId)?.closedAt).toStrictEqual(STARTED_AT);
  });

  it('ends a record this window never started', () => {
    // The M2 case, and the reason the branch exists: a restored record is in the
    // list with no process of ours behind it. Nothing else would ever bring it
    // to an end state -- there is no terminal to raise a close event.
    const { lifecycle, registry } = stand();
    const entry = makeEntry();
    registry.register(entry);

    lifecycle.close(entry.terminalId);

    expect(registry.get(entry.terminalId)?.observed.state).toBe('ended');
    expect(registry.get(entry.terminalId)?.closedAt).toStrictEqual(STARTED_AT);
  });

  it('closes the record of a terminal that is already gone', async () => {
    // There is no handle to destroy -- the process died, or the record was
    // restored into the list without being started (M2). Nothing else would
    // bring such a record to an end state, so this does.
    const { lifecycle, registry, gateway } = stand();
    const entry = await lifecycle.launch(request());
    gateway.handleFor(entry.terminalId).close(undefined, 'shutdown');
    expect(registry.get(entry.terminalId)?.observed.state).toBe('ended');

    lifecycle.close(entry.terminalId);

    expect(registry.get(entry.terminalId)?.closedAt).toStrictEqual(STARTED_AT);
  });

  it('says so when asked to close a terminal it does not hold', () => {
    // Not an exception: the tree offers only records this window has, so
    // getting here means one was dropped between the click and the call.
    const { lifecycle, logger, registry } = stand();

    lifecycle.close(TerminalId.fromString('11111111-2222-4333-8444-555555555555'));

    expect(registry.list()).toStrictEqual([]);
    expect(logger.warnings.map((line) => line.message)).toStrictEqual([
      'close was asked for a terminal this window does not hold',
    ]);
  });
});

describe('TerminalLifecycleService reads a terminal that went away', () => {
  async function closing(
    exit: number | undefined,
    intent: LaunchIntent,
    reason: TerminalExitReason
  ): Promise<{
    readonly state: string;
    readonly signals: readonly string[];
    readonly restorable: boolean;
    readonly event: unknown;
    readonly closedAt: Date | null;
  }> {
    const { lifecycle, registry, gateway, logger } = stand();
    const entry = await lifecycle.launch(request());
    if (intent === 'resume') {
      // The first terminal is over, and the record is being restored -- which
      // is the only way `launching` is ever reached under `resume`.
      gateway.handleFor(entry.terminalId).close(undefined, 'shutdown');
      await lifecycle.start(entry, 'resume');
    }
    const seen = signals(registry);

    gateway.handleFor(entry.terminalId).close(exit, reason);

    const after = registry.get(entry.terminalId);
    return {
      state: after?.observed.state ?? 'gone',
      signals: seen,
      restorable: after?.isRestorable() ?? false,
      event: closeEvents(logger).at(-1),
      closedAt: after?.closedAt ?? null,
    };
  }

  it('calls a non-zero exit during a launch a failed launch', async () => {
    expect(await closing(1, 'launch', 'process')).toMatchObject({
      state: 'ended',
      signals: ['launch_failed'],
      event: 'LaunchExitedNonZero',
    });
  });

  it('calls a non-zero exit during a restore a failed restore', async () => {
    // The same state, the same event shape, a different outcome. The only thing
    // separating them is what this service was asked to do, which is why the
    // producer names the event and the state machine does not (§4.3).
    expect(await closing(1, 'resume', 'process')).toMatchObject({
      state: 'resume_failed',
      signals: ['resume_failed'],
      event: 'ResumeExitedNonZero',
    });
  });

  it('still calls it a failed restore when the CLI announced its own shutdown first', async () => {
    // A45, measured 2026-08-20 against CLI 2.1.233 under a real pty:
    // `claude --resume <a conversation that is not there>` prints "No
    // conversation found with session ID: ...", sends exactly ONE hook --
    // `SessionEnd` with `reason: "other"` -- at about 1.6 s, and exits with
    // code 1 at about 3.15 s. So the CLI's announcement of its own shutdown
    // arrives FIRST and the only evidence about the restore arrives second.
    //
    // The record must reach `resume_failed` all the same. That state is what
    // M2.13 turns into an offer to start the conversation over, and this path
    // -- a conversation that is simply gone -- is the one that needs the offer.
    const { lifecycle, registry, gateway, logger } = stand();
    const entry = await lifecycle.launch(request());
    gateway.handleFor(entry.terminalId).close(undefined, 'shutdown');
    const restored = await lifecycle.start(entry, 'resume');

    // The payload as measured, `reason` included: `other` is also the value we
    // collapse anything unrecognised into, so the body cannot answer the
    // question on its own and the ORDER is the whole of the case.
    registry.receive({
      terminalId: restored.terminalId,
      receivedAt: STARTED_AT,
      raw: JSON.stringify({
        session_id: restored.sessionId.value,
        transcript_path: '/tmp/gripterm-a45.jsonl',
        cwd: '/tmp',
        hook_event_name: 'SessionEnd',
        reason: 'other',
      }),
    });
    expect(registry.get(restored.terminalId)?.observed.state).toBe('launching');

    gateway.handleFor(restored.terminalId).close(1, 'process');

    expect(registry.get(restored.terminalId)?.observed.state).toBe('resume_failed');
    expect(closeEvents(logger).at(-1)).toBe('ResumeExitedNonZero');
  });

  it('calls a clean exit an ordinary end', async () => {
    // `/exit` gives code 0. A person leaving is not a failure to report.
    expect(await closing(0, 'launch', 'process')).toMatchObject({
      state: 'ended',
      signals: ['ended'],
      event: 'TerminalClosed',
    });
  });

  it('calls a terminal the person closed an ordinary end', async () => {
    // `undefined` is what the platform reports both for a person closing the
    // terminal and for us destroying it (A15). Neither is a failed launch.
    expect(await closing(undefined, 'launch', 'user')).toMatchObject({
      state: 'ended',
      signals: ['ended'],
      event: 'TerminalClosed',
    });
  });

  it('keeps a terminal restorable when its process died on its own', async () => {
    // Our terminals are transient, so every editor shutdown kills them all.
    // Tying `closedAt` to a process exit would declare the whole base rubbish
    // at the first restart (§4.2).
    expect(await closing(1, 'launch', 'process')).toMatchObject({ restorable: true });
  });

  /*
   * WHO closed it, which is the other half of the answer and was missing until
   * A29 (2026-08-13).
   *
   * The owner's report is the whole of why these exist: a terminal closed with
   * the cross on its tab came back at the next reload, because `closedAt` was
   * produced by exactly one path -- our own command -- and the editor's is a
   * different one. The old rule was not wrong about the danger it was avoiding;
   * it was reading the wrong field. `exitStatus.code` cannot tell a deliberate
   * close from a shutdown (A15) and `exitStatus.reason` can, so the rule moves
   * onto the field that carries the answer.
   *
   * ONE value closes a record and three do not, and the asymmetry is the design:
   * a record wrongly kept costs a person a row they have to close again, and a
   * record wrongly closed costs them a conversation that never comes back.
   */
  it('closes the record for good when the person closed the terminal', async () => {
    expect(await closing(undefined, 'launch', 'user')).toMatchObject({
      restorable: false,
      closedAt: STARTED_AT,
    });
  });

  it('leaves the record restorable when the window took its terminals with it', async () => {
    // The case that makes this rule safe to have at all. Our terminals are
    // transient, so EVERY editor shutdown closes all of them; reading that as a
    // person's own act would declare the whole base rubbish at the first reload
    // -- the very complaint this change answers, inverted and worse.
    expect(await closing(undefined, 'launch', 'shutdown')).toMatchObject({
      restorable: true,
      closedAt: null,
    });
  });

  it('leaves the record restorable when the process exited on its own', async () => {
    // A `claude` that fell over, and a `claude` that a person ended with
    // `/exit`, are one value to the platform. Reading it as intent would forget
    // a crashed conversation, so it is read as neither.
    expect(await closing(0, 'launch', 'process')).toMatchObject({
      restorable: true,
      closedAt: null,
    });
  });

  /*
   * The half of A29 that makes `reason` alone the WRONG rule, measured
   * 2026-08-13 in a real editor.
   *
   * A terminal in the EDITOR AREA -- which is this build's default
   * (`gripterm.launch.location`) -- reports a process exiting on its own as
   * `user`, because the editor tab closing is what the platform sees. The same
   * process in the panel reports `process`. So `user` does not mean "a person
   * did this"; what it means is "this went through the editor's own close path",
   * and a build that read it as intent would forget every conversation that
   * ended with `/exit` or fell over.
   *
   * What separates them is the code, and it separates them the same way in both
   * areas: a process that exited has one, and a terminal somebody closed has
   * none, because nothing inside it exited (A15). So the rule is the PAIR, and
   * neither half of it is enough alone.
   */
  it('leaves a clean exit in the editor area restorable, although the editor calls it a user close', async () => {
    expect(await closing(0, 'launch', 'user')).toMatchObject({
      state: 'ended',
      restorable: true,
      closedAt: null,
    });
  });

  it('still calls a failed launch in the editor area a failed launch, not a person leaving', async () => {
    expect(await closing(1, 'launch', 'user')).toMatchObject({
      state: 'ended',
      signals: ['launch_failed'],
      event: 'LaunchExitedNonZero',
      restorable: true,
      closedAt: null,
    });
  });

  it('leaves the record restorable when we destroyed the terminal ourselves', async () => {
    // `extension` is the path our own close command already stamped before it
    // disposed anything, so nothing here has to. A record reaching this line
    // WITHOUT that stamp is a terminal something else of ours destroyed, and
    // that is not a person deciding anything.
    expect(await closing(undefined, 'launch', 'extension')).toMatchObject({
      restorable: true,
      closedAt: null,
    });
  });

  it('leaves the record restorable when the editor gave an answer we have no name for', async () => {
    // The direction every unmeasured case falls (§I.1). An editor newer than
    // this build is a thing that happens; a build that read its unknown answer
    // as consent is a build that throws conversations away on an upgrade.
    expect(await closing(undefined, 'launch', 'unknown')).toMatchObject({
      restorable: true,
      closedAt: null,
    });
  });

  /*
   * The two rows the `own` engine adds, fed through the rule that produces them
   * rather than through a pair written out by hand (M3.3).
   *
   * They are here, in the consumer's own suite, because that is where the claim
   * lives: `exitVerdict` dropping the code is not a preference about tidiness,
   * it is the only thing standing between the measurement and a false event.
   * Written against `exitVerdict` itself the assertion would say "the rule does
   * what the rule says"; written here it says what the rule is FOR, and it goes
   * red if either side changes.
   */
  it('does not call our own disposal of a launching terminal a failed launch', async () => {
    // Measured 2026-08-17 (M3.2 stage B, §2): `claude` under `kill()` exits with
    // 1, and `powershell` with -1073741510 -- the code is a property of the
    // program, not of the killing. Passing it through would report a failed
    // launch for every terminal ended while it was still starting, and under
    // `own` ending a terminal IS disposing it.
    const verdict = exitVerdict(CLAUDE_UNDER_KILL, undefined, 'we-disposed');

    expect(await closing(verdict.code, 'launch', verdict.reason)).toMatchObject({
      state: 'ended',
      signals: ['ended'],
      event: 'TerminalClosed',
      restorable: true,
      closedAt: null,
    });
  });

  it('does not call a window reload a failed launch, nor a deliberate close', async () => {
    // Why `deactivate` kills with its own cause (M3.5): a reload that stamped
    // `closedAt` would bring nothing back, and П7 is the promise that everything
    // the person did not close themselves does come back.
    const verdict = exitVerdict(SHELL_UNDER_KILL, undefined, 'we-are-shutting-down');

    expect(await closing(verdict.code, 'launch', verdict.reason)).toMatchObject({
      state: 'ended',
      signals: ['ended'],
      event: 'TerminalClosed',
      restorable: true,
      closedAt: null,
    });
  });

  it('stamps the close with the moment it happened, not the moment it started', async () => {
    const { lifecycle, registry, gateway, clock } = stand();
    const entry = await lifecycle.launch(request());
    clock.advance(60_000);

    gateway.handleFor(entry.terminalId).close(undefined, 'user');

    expect(registry.get(entry.terminalId)?.closedAt).toStrictEqual(
      new Date(STARTED_AT.getTime() + 60_000)
    );
  });

  it('has the record already closed by the time anybody is told it ended', async () => {
    // The same order `close` keeps and for the same reason: a listener told the
    // terminal has ended must see a record that is closed, rather than being
    // told twice about one act. M2's persistence subscribes here, and the
    // difference on disk is a `record.json` written without `closedAt`.
    const { lifecycle, registry, gateway } = stand();
    const entry = await lifecycle.launch(request());
    const closedWhenEnded: (Date | null)[] = [];
    registry.subscribe((change) => {
      if (change.kind === 'entry' && change.transition !== null) {
        closedWhenEnded.push(change.entry.closedAt);
      }
    });

    gateway.handleFor(entry.terminalId).close(undefined, 'user');

    expect(closedWhenEnded).toStrictEqual([STARTED_AT]);
  });

  it('says nothing about a record this window no longer holds', async () => {
    // A close arriving for a record a person deleted a moment ago. `amend`
    // would refuse it and warn, which is a warning about nothing: the terminal
    // really did close, and there is no record left to write it on.
    const { lifecycle, registry, gateway, logger } = stand();
    const entry = await lifecycle.launch(request());
    const handle = gateway.handleFor(entry.terminalId);
    registry.forget(entry.terminalId);
    const warned = logger.warnings.length;

    handle.close(undefined, 'user');

    expect(logger.warnings.slice(warned).map((line) => line.message)).toStrictEqual([
      'an event named a terminal this window does not hold',
    ]);
  });

  it('does not call a late failure a failed launch', async () => {
    // A process that ran for an hour and then died is not a launch that never
    // got going. The state machine would come to the same conclusion about the
    // STATE on its own -- but the record of what happened would then say
    // `LaunchExitedNonZero` about a session that had been talking for an hour,
    // and that record is what M2 persists.
    const { lifecycle, registry, gateway, logger } = stand();
    const entry = await lifecycle.launch(request());
    registry.ingest(entry.terminalId, {
      kind: 'Stop',
      sessionId: entry.sessionId,
      lastAssistantMessage: null,
      promptId: null,
      cwd: null,
      transcriptPath: null,
    });
    const seen = signals(registry);

    gateway.handleFor(entry.terminalId).close(1, 'process');

    expect(registry.get(entry.terminalId)?.observed.state).toBe('ended');
    expect(seen).toStrictEqual(['ended']);
    expect(closeEvents(logger)).toStrictEqual(['TerminalClosed']);
  });

  it('ends a terminal whose process died without a single hook', async () => {
    // The CLI cannot report its own death, so the editor's word is the only
    // evidence there will ever be. Without this subscription the row would sit
    // in `launching` for the life of the window.
    const { lifecycle, registry, gateway } = stand();
    const entry = await lifecycle.launch(request());

    gateway.handleFor(entry.terminalId).close(undefined, 'shutdown');

    expect(registry.get(entry.terminalId)?.observed.state).toBe('ended');
  });

  it('hears a terminal close only once', async () => {
    // The state would hide a second hearing: the machine refuses a second death
    // for one terminal, so only the event count shows it. A subscription that
    // outlived its terminal is how a listener leak starts.
    const { lifecycle, registry, gateway, logger } = stand();
    const entry = await lifecycle.launch(request());
    const handle = gateway.handleFor(entry.terminalId);
    const seen = signals(registry);

    handle.close(undefined, 'shutdown');
    handle.close(undefined, 'shutdown');

    expect(seen).toStrictEqual(['ended']);
    expect(closeEvents(logger)).toStrictEqual(['TerminalClosed']);
  });
});

describe('TerminalLifecycleService lets go', () => {
  it('stops listening to the terminals it started', async () => {
    const { lifecycle, registry, gateway } = stand();
    const entry = await lifecycle.launch(request());
    const seen = signals(registry);

    lifecycle.dispose();
    gateway.handleFor(entry.terminalId).close(1, 'process');

    expect(seen).toStrictEqual([]);
  });

  it('does not destroy anybody, because deactivating is not a decision about a conversation', async () => {
    const { lifecycle, gateway } = stand();
    const entry = await lifecycle.launch(request());

    lifecycle.dispose();

    expect(gateway.handleFor(entry.terminalId).disposed).toBe(false);
  });
});

describe('one terminal closing is one terminal closing', () => {
  it('leaves the others alone', async () => {
    const { lifecycle, registry, gateway } = stand();
    const first = await lifecycle.launch(request('one'));
    const second = await lifecycle.launch(request('two'));

    gateway.handleFor(first.terminalId).close(1, 'process');

    expect(registry.get(second.terminalId)?.observed.state).toBe('launching');
    expect(registry.get(first.terminalId)?.observed.state).toBe('ended');
  });
});

describe('deleting the record of a terminal', () => {
  it('drops it from the list once its terminal is gone', async () => {
    const { lifecycle, gateway, registry } = stand();
    const entry = await lifecycle.launch(request());
    gateway.handleFor(entry.terminalId).close(undefined, 'user');

    expect(lifecycle.discard(entry.terminalId)).toBe('discarded');

    expect(registry.knows(entry.terminalId)).toBe(false);
    expect(registry.list()).toStrictEqual([]);
  });

  it('refuses while this window still has a process for it', async () => {
    // The evidence is the watch and not the record's state: a record can look
    // finished while its terminal is still open, and deleting under an open
    // terminal leaves a pane nothing can name.
    const { lifecycle, registry, logger } = stand();
    const entry = await lifecycle.launch(request());

    expect(lifecycle.discard(entry.terminalId)).toBe('still-running');

    expect(registry.knows(entry.terminalId)).toBe(true);
    expect(logger.warnings.at(-1)?.message).toContain('still running');
  });

  it('refuses a terminal this window does not hold, and does not shout about it', () => {
    const { lifecycle, logger } = stand();

    expect(lifecycle.discard(TerminalId.fromString(ABSENT))).toBe('unknown-terminal');

    expect(logger.warnings).toStrictEqual([]);
    expect(logger.infos.at(-1)?.message).toContain('does not hold');
  });

  it('does not destroy the terminal, close the record, or touch its neighbours', async () => {
    const { lifecycle, gateway, registry } = stand();
    const kept = await lifecycle.launch(request('kept'));
    const going = await lifecycle.launch(request('going'));
    gateway.handleFor(going.terminalId).close(undefined, 'user');

    lifecycle.discard(going.terminalId);

    expect(gateway.handleFor(going.terminalId).disposed).toBe(false);
    expect(gateway.handleFor(kept.terminalId).disposed).toBe(false);
    expect(registry.own().map((entry) => entry.metadata.displayName)).toStrictEqual(['kept']);
    expect(registry.get(kept.terminalId)?.closedAt).toBeNull();
  });

  it('is a deliberate change, so the record leaves the store at once', async () => {
    // The removal reaches the disk through the same listener every other change
    // takes (M2.6), and this is the shape of it: an id, and no entry.
    const { lifecycle, gateway, registry } = stand();
    const entry = await lifecycle.launch(request());
    gateway.handleFor(entry.terminalId).close(undefined, 'user');
    const seen: RegistryChange[] = [];
    registry.subscribe((change) => seen.push(change));

    lifecycle.discard(entry.terminalId);

    expect(seen).toStrictEqual([{ kind: 'removed', terminalId: entry.terminalId }]);
  });
});

/*
 * Starting over (M2.13).
 *
 * What a restore that failed leaves behind is a record whose metadata is intact
 * and whose conversation cannot be continued. The offer is to keep the work and
 * begin a new conversation -- which is a NEW record, because the old one names a
 * conversation that still exists in the CLI's store and must go on naming it.
 *
 * Two rules carry the whole operation and both are about О3, "a full restart
 * creates no duplicate terminal": nothing starts while this window still holds a
 * process for the record, and the old record is archived only AFTER the new
 * terminal exists.
 */
describe('starting a terminal over', () => {
  /** A record with a person's work on it, and no process of ours. */
  function abandoned(registry: SessionRegistry): TerminalEntry {
    const entry = makeEntry();
    registry.register(entry);
    return entry;
  }

  /** The same stand, with an editor that will not open a terminal. */
  function refusingStand(): { registry: SessionRegistry, lifecycle: TerminalLifecycleService } {
    const clock = new FixedClock(STARTED_AT);
    const logger = new RecordingLogger();
    const registry = new SessionRegistry({
      stateMachine: new TerminalStateMachine(),
      reader: new HookEventParser(),
      clock,
      logger,
    });
    const lifecycle = new TerminalLifecycleService({
      registry,
      gateway: new RefusingGateway(),
      commands: new StubAgentCommands(),
      strategy: new ProcessLaunchStrategy(),
      ids: new SequentialIdGenerator(),
      clock,
      owner: makeOwnerRef(),
      logger,
    });
    return { registry, lifecycle };
  }

  it('carries the work onto a new record and starts it', async () => {
    const { lifecycle, registry, gateway, commands } = stand();
    const old = abandoned(registry);

    const outcome = await lifecycle.startOver(old.terminalId);

    expect(outcome.kind).toBe('started');
    const next = registry.own()[0];
    expect(next).toBeDefined();
    // The person's work, carried whole rather than re-created: name, task,
    // notes, tags and colour are what makes the row worth keeping at all.
    expect(next?.metadata).toBe(old.metadata);
    expect(next?.metadata.task).toBe('Move token validation into its own service');
    expect(next?.metadata.notes).toHaveLength(1);
    // And the recipe, because starting over means the same project with the
    // same flags -- a terminal in a different folder is a different terminal.
    expect(next?.launch).toBe(old.launch);
    expect(next?.observed.state).toBe('launching');
    expect(gateway.specs).toHaveLength(1);
    expect(commands.asked.map((ask) => ask.intent)).toStrictEqual(['launch']);
  });

  it('gives the new record a conversation of its own', async () => {
    // The whole point of a new record rather than a new id on the old one: the
    // conversation that failed is still in the CLI's store, still resumable by
    // hand, and still the thing `agents --json` may report as running. A record
    // that claimed it would veto its own restore (M2.10) and would route that
    // conversation's late events into the new one.
    const { lifecycle, registry } = stand();
    const old = abandoned(registry);

    await lifecycle.startOver(old.terminalId);

    const next = registry.own()[0];
    expect(next?.terminalId.equals(old.terminalId)).toBe(false);
    expect(next?.sessionId.equals(old.sessionId)).toBe(false);
    expect(next?.sessionIdHistory).toStrictEqual([]);
    expect(next?.claimsAnyOf(new Set([old.sessionId.value]))).toBe(false);
    expect(next?.revision).toBe(0);
    expect(next?.closedAt).toBeNull();
  });

  it('archives the old record, and only once the new terminal exists', async () => {
    // The order is the reversibility (§I.3). Archive first and a start that
    // throws leaves the person with nothing on screen and their notes in the
    // trash; start first and the worst case is two rows, which they can see.
    const { lifecycle, registry } = stand();
    const old = abandoned(registry);
    const seen: string[] = [];
    registry.subscribe((change: RegistryChange) => {
      seen.push(change.kind === 'removed' ? `removed ${change.terminalId.value}` : change.kind);
    });

    await lifecycle.startOver(old.terminalId);

    expect(seen).toStrictEqual(['entry', `removed ${old.terminalId.value}`]);
    expect(registry.knows(old.terminalId)).toBe(false);
    expect(registry.own()).toHaveLength(1);
  });

  it('keeps the old record when the new terminal could not be started', async () => {
    const { lifecycle, registry } = refusingStand();
    const old = abandoned(registry);

    await expect(lifecycle.startOver(old.terminalId)).rejects.toThrow('the editor refused');

    expect(registry.knows(old.terminalId)).toBe(true);
    expect(registry.own()).toHaveLength(1);
  });

  it('refuses while this window still has a process for the record', async () => {
    // О3 in one line. A failed restore in the editor leaves a LIVE `claude`
    // in an open pane -- measured, A26 -- and starting over on top of that is
    // how one terminal becomes two.
    const { lifecycle, registry, gateway } = stand();
    const running = await lifecycle.launch(request());

    const outcome = await lifecycle.startOver(running.terminalId);

    expect(outcome.kind).toBe('still-running');
    expect(registry.knows(running.terminalId)).toBe(true);
    expect(registry.own()).toHaveLength(1);
    expect(gateway.specs).toHaveLength(1);
  });

  it('refuses a record this window does not hold', async () => {
    const { lifecycle, gateway } = stand();

    const outcome = await lifecycle.startOver(TerminalId.fromString(ABSENT));

    expect(outcome.kind).toBe('unknown-terminal');
    expect(gateway.specs).toHaveLength(0);
  });

  it('writes down the conversation it left behind', async () => {
    // The id is the only handle on that conversation that exists anywhere: the
    // record carrying it has just been archived, and `claude --resume <id>` is
    // what reaches it afterwards. Left unsaid, starting over would quietly make
    // one thing irreversible.
    const { lifecycle, registry, logger } = stand();
    const old = abandoned(registry);

    await lifecycle.startOver(old.terminalId);

    const line = logger.infos.find((entry) => entry.message === 'a terminal was started over');
    expect(line?.details?.leftBehind).toBe(old.sessionId.value);
  });
});

/**
 * The engine goes into the record from the GATEWAY, immediately after the create
 * that produced the terminal.
 *
 * One line, one moment, and both were chosen against a named failure. The plan's
 * hazard (M3.4(4)) is a record that says `own` for a terminal the editor made:
 * after a fallback -- the setting says `own`, the native addon did not load, the
 * `editor` gateway takes over -- a record repeating the SETTING would point
 * reconciliation at a live `claude` that survives the extension host on purpose
 * (M2.16), and it would kill it through the door the rollback opened.
 *
 * Reading it off the gateway makes that state unreachable rather than merely
 * unlikely: the object that made the terminal is the object that names the
 * engine, so there is no second value for a wiring mistake to disagree with.
 * It is stamped AFTER `create` for the same reason -- a launch that never
 * produced a terminal publishes no record at all.
 */
describe('the engine that made the terminal reaches the record', () => {
  it('writes what the gateway says, not what a setting said', async () => {
    const { lifecycle, registry, gateway } = stand();
    gateway.engine = 'own';

    const entry = await lifecycle.launch(request());

    expect(entry.engine).toBe('own');
    expect(registry.get(entry.terminalId)?.engine).toBe('own');
  });

  it('writes editor when the editor engine made it', async () => {
    const { lifecycle, registry } = stand();

    const entry = await lifecycle.launch(request());

    expect(entry.engine).toBe('editor');
    expect(registry.get(entry.terminalId)?.engine).toBe('editor');
  });

  it('restamps a record that was made by the other engine', async () => {
    // The restore path, where the lie would otherwise live: a record stored by a
    // window running `own` is started again by a window that fell back to
    // `editor`, and the stored word is the wrong one from the moment the new
    // terminal exists.
    const { lifecycle, registry } = stand();

    const entry = await lifecycle.start(makeEntry({ engine: 'own' }), 'resume');

    expect(entry.engine).toBe('editor');
    expect(registry.get(entry.terminalId)?.engine).toBe('editor');
  });
});
