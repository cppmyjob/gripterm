import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BaseProjection,
  FileLaunchTrace,
  FileOwnerPresence,
  FileTerminalRepository,
  HookEventParser,
  OwnerId,
  OwnerRef,
  ProcessLaunchStrategy,
  RestoreOrchestrator,
  SessionRegistry,
  StorageLayout,
  TerminalLifecycleService,
  TerminalStateMachine,
  gatherRestoreInputs,
  planRestore,
  type AgentCommand,
  type AgentCommandFactory,
  type LaunchIntent,
  type RestorePlan,
  type TerminalEntry,
} from '../../packages/core/src/index';
import {
  readAgentRecording,
  recordedAgent,
} from '../../packages/core/src/domain/agents/recorded/recorded-agent';
import {
  FakeScheduler,
  FixedClock,
  InMemoryTerminalGateway,
  RecordingLogger,
  SequentialIdGenerator,
} from '../helpers/port-fakes';
import type { ObservedAgent } from '../../packages/core/src/domain/ports/observed-agent';

/**
 * S01, the scenario a person meets every morning: open the project, and
 * yesterday's agents are back -- CONTINUING their conversations, not starting
 * new ones in their place.
 *
 * **Why this could not be written before today.** The `--resume` half of the
 * restore has never been exercised by anything that runs. The integration host
 * exercises the other half and says so in its own words: the record it seeds has
 * no transcript, "none could be given it without writing into the owner's
 * `~/.claude`", so the planner answers `no-transcript` and the product's answer
 * to that is a NEW conversation. 64 starts recorded by the stand, 64 `launch`,
 * 0 `resume`. Reaching the resume branch needed a way to say "this conversation
 * has something behind it" without touching a person's transcripts, and that is
 * what the second implementation of `ConversationTranscripts` is.
 *
 * **What it does NOT claim.** No editor, so nothing here says the row appeared
 * or the tab came back; that is the stand's business. What it does hold is the
 * chain a person's morning actually depends on -- a real store on a real disk, a
 * real repository, the real gatherer, the real planner, the real orchestrator,
 * the real lifecycle -- with two doubles only: the terminal gateway (there is no
 * editor) and the command factory (there is no CLI to start).
 *
 * **The falsifier, named because an acceptance without one is a ritual.** Take
 * the `witnessed-end` branch out of `livenessRule` -- the state of the rule
 * before `27b2b33` -- and the two records below come back refused. Their state
 * is `ended` and their pid is `null`, which is the exact shape that cost the
 * owner every conversation they had on 2026-08-23, and the shape the old rule
 * read as "it may still be running".
 */

const THE_CONVERSATION = '0170f33a-8e16-45a8-a9d5-38f5d8306e1e';
const THE_SECOND_CONVERSATION = 'a8d4d464-bac1-4f11-9602-094efb84c677';
const ONE_THAT_IS_RUNNING = 'fd080e74-3859-4efb-b554-2d03b86366ad';

const FIRST_TERMINAL = '44ca4fff-c531-485d-a49d-50befd27cb37';
const SECOND_TERMINAL = '88d60282-0b18-4d80-917c-f11bf1b294a7';
const THIRD_TERMINAL = '3bfc0756-a584-44ab-8743-4af0fb2dbd83';

/** An owner id no presence file names, which is what "the window is gone" means on disk. */
const A_WINDOW_THAT_CLOSED = 'f43bc597-5820-4b0d-a0a6-aee0eb7b85ab';

/** This window, the one that opens in the morning. */
const THIS_WINDOW = '5c7f4a1e-9b2d-4c3a-8e6f-1a2b3c4d5e6f';

/** The pid the third record is running as, and it is on the roster. */
const A_LIVE_PID = 8236;

const EXECUTABLE = 'C:/Users/x/.local/bin/claude.exe';
const NOW = new Date('2026-08-27T10:30:00.000Z');
/** An hour, so that nothing below is saved by the boot rule instead of by the rule under test. */
const UPTIME_SECONDS = 3600;

/**
 * A record of a window that is gone, in the shape the store really writes.
 *
 * Copied field for field from `.vscode-test/store-stand/terminals`, which is a
 * recording of this product writing records for itself -- the plan's first rule
 * for a fake, applied to the seed as well as to the agent.
 */
function recordOf(terminalId: string, sessionId: string): unknown {
  return {
    terminalId,
    sessionId,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: A_WINDOW_THAT_CLOSED,
      editorKind: 'cursor',
      workspaceFolder: null,
    },
    metadata: { displayName: `record ${terminalId.slice(0, 8)}`, task: null, notes: [], tags: [], color: null },
    launch: {
      cwd: tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    engine: 'editor',
    order: null,
    createdAt: NOW.getTime() - 600_000,
    closedAt: null,
    closedBy: null,
    revision: 3,
  };
}

/**
 * The snapshot of a conversation the editor was seen to end.
 *
 * `state: 'ended'` and `pid: null` together are the shape of 2026-08-23: the
 * editor destroyed the terminal and said so, and nothing ever wrote a pid. The
 * `lastEventAt` is deliberately recent -- ten minutes, against an hour of uptime
 * -- so that `older-than-the-boot` cannot answer for this record and the rule
 * under test is the only thing that can.
 */
function observedOf(pid: number | null, state: string): unknown {
  return {
    state,
    lastEventAt: NOW.getTime() - 600_000,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
    running: [],
  };
}

async function seed(store: string): Promise<void> {
  const written: [string, string, number | null, string][] = [
    [FIRST_TERMINAL, THE_CONVERSATION, null, 'ended'],
    [SECOND_TERMINAL, THE_SECOND_CONVERSATION, null, 'ended'],
    /*
     * The one that must NOT come back, and it is the same shape as the two
     * above: a witnessed end and no pid. Everything WE know about it says the
     * conversation is over. The only thing that stops it is the roster, which
     * names that conversation as running under a pid this record never had --
     * which is exactly the mistake the whole design is built against, and the
     * only guard against it is the port this scenario is about.
     */
    [THIRD_TERMINAL, ONE_THAT_IS_RUNNING, null, 'ended'],
  ];
  for (const [terminalId, sessionId, pid, state] of written) {
    const directory = join(store, 'terminals', terminalId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'observed.json'), JSON.stringify(observedOf(pid, state)), 'utf8');
    await writeFile(join(directory, 'record.json'), JSON.stringify(recordOf(terminalId, sessionId)), 'utf8');
  }
}

/**
 * The machine this morning, as a recording.
 *
 * One conversation is running (the third record's), and two have transcripts
 * behind them and nothing on them. That is the ordinary morning: the window
 * that held them is gone, the processes went with it, and the conversations are
 * on disk waiting to be continued.
 */
function theMachine(): ObservedAgent {
  const recording = readAgentRecording({
    agent: 'a recording of a morning',
    build: '2.1.245',
    capturedAt: '2026-08-27T10:29:00.000Z',
    running: {
      kind: 'listed',
      agents: [
        {
          sessionId: ONE_THAT_IS_RUNNING,
          pid: A_LIVE_PID,
          cwd: tmpdir(),
          kind: 'interactive',
          startedAt: NOW.getTime() - 900_000,
          name: null,
          status: 'busy',
        },
      ],
      skipped: 0,
    },
    transcripts: {
      kind: 'indexed',
      sessionIds: [THE_CONVERSATION, THE_SECOND_CONVERSATION, ONE_THAT_IS_RUNNING],
      skipped: 0,
    },
  });
  if (recording === null) {
    throw new Error('the recording of the morning could not be read');
  }
  // Everything in the recording was alive when it was taken, which is what
  // replaying a morning means.
  return recordedAgent(recording, () => true);
}

class StubCommands implements AgentCommandFactory {
  public readonly asked: { readonly terminalId: string, readonly intent: LaunchIntent }[] = [];

  public async commandFor(entry: TerminalEntry, intent: LaunchIntent): Promise<AgentCommand> {
    this.asked.push({ terminalId: entry.terminalId.value, intent });
    return await Promise.resolve({
      executable: EXECUTABLE,
      args: intent === 'resume'
        ? ['--resume', entry.sessionId.value, '--settings', 'settings.json']
        : ['--session-id', entry.sessionId.value, '--settings', 'settings.json'],
      env: {},
    });
  }
}

interface Morning {
  readonly store: string;
  readonly plan: RestorePlan;
  readonly started: number;
  readonly commands: StubCommands;
  readonly logger: RecordingLogger;
}

/** One window opening in the morning, from an empty desk to terminals on disk. */
async function openTheProject(agent: ObservedAgent): Promise<Morning> {
  const store = await mkdtemp(join(tmpdir(), 'gripterm-s01-'));
  await seed(store);

  const layout = new StorageLayout(store);
  const clock = new FixedClock(NOW);
  const logger = new RecordingLogger();
  const ownerId = OwnerId.fromString(THIS_WINDOW);
  const owner: OwnerRef = OwnerRef.create({
    kind: 'window',
    ownerId,
    editorKind: 'cursor',
    workspaceFolder: null,
  });

  const presence = new FileOwnerPresence({ layout, clock, logger });
  await presence.announce({
    ownerId,
    kind: 'window',
    pid: process.pid,
    editorKind: 'cursor',
    editorVersion: '0.0.0-scenario',
    workspaceFolders: [],
  });

  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  const repository = new FileTerminalRepository({ layout, owner, presence, clock, logger });
  const projection = new BaseProjection({ repository, registry, owner, logger });
  await projection.refresh();

  const commands = new StubCommands();
  const lifecycle = new TerminalLifecycleService({
    registry,
    gateway: new InMemoryTerminalGateway(),
    commands,
    strategy: new ProcessLaunchStrategy(),
    ids: new SequentialIdGenerator(),
    clock,
    owner,
    logger,
    trace: new FileLaunchTrace({ layout, clock, logger }),
  });

  const inputs = await gatherRestoreInputs({
    repository,
    presence,
    windowFolders: [],
    readTranscripts: async () => await agent.transcripts.index(),
    readAgents: async () => await agent.roster.list(),
    nowMs: NOW.getTime(),
    uptimeSeconds: UPTIME_SECONDS,
    logger,
    // Nothing is probed for liveness here: what the machine is running comes
    // from the roster, which is the port this scenario exists to exercise.
    probe: () => 'unknown',
  });
  const plan = planRestore(inputs);
  const report = await new RestoreOrchestrator({
    repository,
    registry,
    lifecycle,
    scheduler: new FakeScheduler(),
    logger,
  }).run(plan);

  return { store, plan, started: report.started, commands, logger };
}

async function startsOf(store: string, terminalId: string): Promise<string> {
  return await readFile(join(store, 'terminals', terminalId, 'starts.jsonl'), 'utf8').catch(() => '');
}

describe('S01: the morning after, with a recording of the machine standing in for the CLI', () => {
  let morning: Morning;

  beforeAll(async () => {
    morning = await openTheProject(theMachine());
  });

  afterAll(async () => {
    await rm(morning.store, { recursive: true, force: true });
  });

  it('brings back the records of the window that closed, without anybody asking', () => {
    expect(morning.plan.steps.map((step) => step.entry.terminalId.value).sort()).toStrictEqual(
      [FIRST_TERMINAL, SECOND_TERMINAL].sort()
    );
    expect(morning.started).toBe(2);
  });

  it('CONTINUES the conversations rather than replacing them, which is the half nothing has ever run', () => {
    expect(morning.plan.steps.map((step) => step.intent)).toStrictEqual(['resume', 'resume']);
    expect(morning.commands.asked.map((one) => one.intent)).toStrictEqual(['resume', 'resume']);
  });

  it('leaves the evidence on disk, in the record`s own trace, which is what S01 asks to see', async () => {
    const trace = await startsOf(morning.store, FIRST_TERMINAL);

    expect(trace).toContain('"what":"start"');
    expect(trace).toContain('"intent":"resume"');
    expect(trace).toContain(`"session":"${THE_CONVERSATION}"`);
  });

  it('leaves alone the conversation the machine says is running, so this is not a plan that says yes to everything', async () => {
    expect(morning.plan.steps.map((step) => step.entry.terminalId.value)).not.toContain(THIRD_TERMINAL);
    expect(morning.plan.skipped.map((one) => one.reason)).toContain('session-listed');
    // Nothing was started for it, which is the half a plan alone cannot show.
    expect(await startsOf(morning.store, THIRD_TERMINAL)).toBe('');
  });

  it('is the shape the rule before 27b2b33 refused, so this scenario has a falsifier', async () => {
    // Said as an assertion rather than in prose: both records carry a witnessed
    // end and no pid, which is the pair the old rule read as "it may still be
    // running". Take `witnessed-end` out of `livenessRule` and the first test
    // above goes red.
    const observed = JSON.parse(
      await readFile(join(morning.store, 'terminals', FIRST_TERMINAL, 'observed.json'), 'utf8')
    ) as { state: string, pid: number | null };

    expect(observed.state).toBe('ended');
    expect(observed.pid).toBeNull();
  });
});
