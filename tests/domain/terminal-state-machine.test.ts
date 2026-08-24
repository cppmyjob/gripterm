import {
  SessionId,
  TerminalStateMachine,
  ValidationError,
  launchExitedNonZero,
  processGone,
  resumeExitedNonZero,
  resumeTimedOut,
  terminalClosed,
  wentQuiet,
  type AgentEventContext,
  type AgentNoticeType,
  type PersistedTerminalState,
  type StateTransition,
  type TerminalEvent,
} from '../../packages/core/src/index';
import { SESSION_UUID } from '../helpers/domain-fixtures';

const CONTEXT: AgentEventContext = {
  sessionId: SessionId.fromString(SESSION_UUID),
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

function notification(notificationType: AgentNoticeType): TerminalEvent {
  return { kind: 'AgentNotified', notificationType, message: null, ...CONTEXT };
}

/**
 * The columns of the table.
 *
 * `AgentNotified` is four columns rather than one because its `notificationType`
 * is what chooses the target state -- collapsing it to a single column would
 * hide three of the four behaviours behind whichever type the test happened to
 * pick.
 */
const EVENT_CASES = {
  ConversationStarted: { kind: 'ConversationStarted', source: 'startup', ...CONTEXT },
  ConversationEnded: { kind: 'ConversationEnded', reason: 'logout', ...CONTEXT },
  PromptSubmitted: { kind: 'PromptSubmitted', userInput: 'go', ...CONTEXT },
  ToolStarted: { kind: 'ToolStarted', toolName: 'Bash', toolUseId: null, ...CONTEXT },
  ToolFinished: { kind: 'ToolFinished', toolName: 'Bash', toolUseId: null, ...CONTEXT },
  ToolFailed: {
    kind: 'ToolFailed',
    toolName: 'Bash',
    toolUseId: null,
    errorMessage: null,
    ...CONTEXT,
  },
  PermissionRequested: {
    kind: 'PermissionRequested',
    toolName: 'Bash',
    permissionLevel: null,
    ...CONTEXT,
  },
  'AgentNotified:agent_needs_input': notification('agent_needs_input'),
  'AgentNotified:idle_prompt': notification('idle_prompt'),
  'AgentNotified:agent_completed': notification('agent_completed'),
  'AgentNotified:other': notification('auth_success'),
  TurnFinished: { kind: 'TurnFinished', lastAssistantMessage: null, ...CONTEXT },
  SubagentStarted: { kind: 'SubagentStarted', agentId: 'a0f2051a530b4c7a2', agentType: 'general-purpose', ...CONTEXT },
  SubagentFinished: { kind: 'SubagentFinished', agentId: 'a0f2051a530b4c7a2', agentType: 'general-purpose', ...CONTEXT },
  TurnFailed: { kind: 'TurnFailed', errorType: null, errorMessage: null, ...CONTEXT },
  WorkingDirectoryChanged: { kind: 'WorkingDirectoryChanged', oldCwd: null, newCwd: null, ...CONTEXT },
  ResumeTimedOut: resumeTimedOut(),
  WentQuiet: wentQuiet(),
  ProcessGone: processGone(4242),
  TerminalClosed: terminalClosed(),
  LaunchExitedNonZero: launchExitedNonZero(1),
  ResumeExitedNonZero: resumeExitedNonZero(1),
} as const satisfies Record<string, TerminalEvent>;

type ColumnName = keyof typeof EVENT_CASES;

/**
 * Every kind in the union, written out so that the compiler refuses a union
 * member nobody gave a column. The runtime check below then refuses the reverse
 * -- a column list that has drifted away from the union.
 */
const EVENT_KINDS: Record<TerminalEvent['kind'], true> = {
  ConversationStarted: true,
  ConversationEnded: true,
  PromptSubmitted: true,
  ToolStarted: true,
  ToolFinished: true,
  ToolFailed: true,
  PermissionRequested: true,
  AgentNotified: true,
  TurnFinished: true,
  SubagentStarted: true,
  SubagentFinished: true,
  TurnFailed: true,
  WorkingDirectoryChanged: true,
  ResumeTimedOut: true,
  WentQuiet: true,
  ProcessGone: true,
  TerminalClosed: true,
  LaunchExitedNonZero: true,
  ResumeExitedNonZero: true,
};

/**
 * Which column stands in for each notification type. Written as a total record
 * so that a type added to the union cannot quietly land in `other` -- the
 * compiler asks for the decision.
 */
const NOTIFICATION_COLUMN: Record<AgentNoticeType, ColumnName> = {
  agent_needs_input: 'AgentNotified:agent_needs_input',
  idle_prompt: 'AgentNotified:idle_prompt',
  agent_completed: 'AgentNotified:agent_completed',
  auth_success: 'AgentNotified:other',
  computer_use_enter: 'AgentNotified:other',
  computer_use_exit: 'AgentNotified:other',
  elicitation_complete: 'AgentNotified:other',
  elicitation_response: 'AgentNotified:other',
  push_notification: 'AgentNotified:other',
  worker_permission_prompt: 'AgentNotified:other',
  other: 'AgentNotified:other',
};

/** A cell either names the state the machine lands in, or says the event was not applied. */
const NOT_APPLIED = 'not-applied';
type Cell = PersistedTerminalState | typeof NOT_APPLIED;

type Row = Record<ColumnName, Cell>;

/**
 * The whole product, written out by hand and on purpose.
 *
 * This is the point of M1.4. An exhaustive `switch` over the event union proves
 * that no event is unhandled; it says nothing about a **pair**. The defect that
 * survived nine review rounds was a pair: `waiting_permission` had no way out,
 * because the three tool events had a relative target ("stays `working`") and
 * `TurnFinished` was the only edge that ever left. Nothing in the implementation could
 * have flagged that -- but the `waiting_permission` row below has a cell for
 * `ToolFinished`, and an empty one would have been visible.
 *
 * `Record<PersistedTerminalState, Row>` and `Record<ColumnName, Cell>` are what
 * keep it from rotting: a new state or a new event fails to compile until every
 * cell it introduces has been decided.
 */
const TABLE: Record<PersistedTerminalState, Row> = {
  launching: {
    ConversationStarted: 'idle',
    ConversationEnded: NOT_APPLIED,
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'launching',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'launching',
    ResumeTimedOut: 'degraded',
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'resume_failed',
  },
  idle: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'idle',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'idle',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  working: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'working',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'working',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: 'degraded',
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  // The row round 10 was missing. Every tool event leaves; `TurnFinished` is not the
  // only exit, and M1.11a's `waiting_permission -> working -> waiting_permission`
  // is a real path rather than a fixture invented for a mock.
  waiting_permission: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'waiting_permission',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'waiting_permission',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  waiting_input: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'waiting_input',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'waiting_input',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  turn_failed: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'turn_failed',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'turn_failed',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  // A witnessed end. The single live cell is `ConversationStarted`, which is how a
  // terminal gets back out of the `ConversationEnded(clear)` that `/clear` sends
  // before it opens the new conversation.
  ended: {
    ConversationStarted: 'idle',
    ConversationEnded: NOT_APPLIED,
    PromptSubmitted: NOT_APPLIED,
    ToolStarted: NOT_APPLIED,
    ToolFinished: NOT_APPLIED,
    ToolFailed: NOT_APPLIED,
    PermissionRequested: NOT_APPLIED,
    'AgentNotified:agent_needs_input': NOT_APPLIED,
    'AgentNotified:idle_prompt': NOT_APPLIED,
    'AgentNotified:agent_completed': NOT_APPLIED,
    'AgentNotified:other': NOT_APPLIED,
    TurnFinished: NOT_APPLIED,
    SubagentStarted: NOT_APPLIED,
    SubagentFinished: NOT_APPLIED,
    TurnFailed: NOT_APPLIED,
    WorkingDirectoryChanged: NOT_APPLIED,
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: NOT_APPLIED,
    TerminalClosed: NOT_APPLIED,
    LaunchExitedNonZero: NOT_APPLIED,
    ResumeExitedNonZero: NOT_APPLIED,
  },
  // An inference, not a witness: reconciliation failed to find a process. Any
  // hook disproves it, and the two hooks that carry no phase leave us knowing
  // only that something is alive -- which is `degraded`, spelled out.
  orphaned: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'degraded',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'degraded',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  degraded: {
    ConversationStarted: 'idle',
    ConversationEnded: 'ended',
    PromptSubmitted: 'working',
    ToolStarted: 'working',
    ToolFinished: 'working',
    ToolFailed: 'working',
    PermissionRequested: 'waiting_permission',
    'AgentNotified:agent_needs_input': 'waiting_input',
    'AgentNotified:idle_prompt': 'idle',
    'AgentNotified:agent_completed': 'idle',
    'AgentNotified:other': 'degraded',
    TurnFinished: 'idle',
    SubagentStarted: 'working',
    SubagentFinished: 'idle',
    TurnFailed: 'turn_failed',
    WorkingDirectoryChanged: 'degraded',
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  resume_failed: {
    ConversationStarted: 'idle',
    ConversationEnded: NOT_APPLIED,
    PromptSubmitted: NOT_APPLIED,
    ToolStarted: NOT_APPLIED,
    ToolFinished: NOT_APPLIED,
    ToolFailed: NOT_APPLIED,
    PermissionRequested: NOT_APPLIED,
    'AgentNotified:agent_needs_input': NOT_APPLIED,
    'AgentNotified:idle_prompt': NOT_APPLIED,
    'AgentNotified:agent_completed': NOT_APPLIED,
    'AgentNotified:other': NOT_APPLIED,
    TurnFinished: NOT_APPLIED,
    SubagentStarted: NOT_APPLIED,
    SubagentFinished: NOT_APPLIED,
    TurnFailed: NOT_APPLIED,
    WorkingDirectoryChanged: NOT_APPLIED,
    ResumeTimedOut: NOT_APPLIED,
    WentQuiet: NOT_APPLIED,
    ProcessGone: NOT_APPLIED,
    TerminalClosed: NOT_APPLIED,
    LaunchExitedNonZero: NOT_APPLIED,
    ResumeExitedNonZero: NOT_APPLIED,
  },
};

const STATES = Object.keys(TABLE) as readonly PersistedTerminalState[];
/** The two states a hook cannot get back out of, spelled here so a test can say so. */
const WITNESSED_END: ReadonlySet<PersistedTerminalState> = new Set(['ended', 'resume_failed']);
const COLUMNS = Object.keys(EVENT_CASES) as readonly ColumnName[];

const machine = new TerminalStateMachine();

function cellOf(transition: StateTransition): Cell {
  if (transition.kind === 'moved') {
    return transition.to;
  }
  if (transition.kind === 'stayed') {
    return transition.state;
  }
  return NOT_APPLIED;
}

function rowOf(state: PersistedTerminalState): Row {
  const cells = COLUMNS.map((column) => [column, cellOf(machine.apply(state, EVENT_CASES[column]))]);
  return Object.fromEntries(cells) as Row;
}

describe('the table covers the product and nothing else', () => {
  it('has a row for every persisted state and a column for every event kind', () => {
    expect(STATES).toHaveLength(10);
    expect(new Set(COLUMNS.map((column) => EVENT_CASES[column].kind))).toStrictEqual(
      new Set(Object.keys(EVENT_KINDS))
    );
  });

  it('accounts for every notification type, and none of them lands in `other` by accident', () => {
    const disagreements = Object.entries(NOTIFICATION_COLUMN).flatMap(([type, column]) =>
      STATES
        .filter(
          (state) =>
            cellOf(machine.apply(state, notification(type as AgentNoticeType))) !==
            cellOf(machine.apply(state, EVENT_CASES[column]))
        )
        .map((state) => `${type} in ${state}`)
    );

    expect(Object.keys(NOTIFICATION_COLUMN)).toHaveLength(11);
    expect(disagreements).toStrictEqual([]);
  });
});

describe.each(STATES)('from %s', (state) => {
  it('lands where the table says, for all twenty events', () => {
    expect(rowOf(state)).toStrictEqual(TABLE[state]);
  });
});

/*
 * The customer's fifth complaint, 2026-08-21: "Иногда, не всегда, основной
 * агент запускает агентов и ждёт тихо -- в этот момент иконка состояния
 * показывает не спиннер а зелёную галку."
 *
 * MEASURED, twice, against a real CLI with all thirty-one hooks registered
 * (2026-08-21). The second run, with two subagents each sleeping a minute:
 *
 *   17.77  SubagentStarted  a0f2...      <- two subagents begin
 *   19.22  SubagentStarted  a1e4...
 *   25.69  TurnFinished                        <- the MAIN turn ends here, no agent_id
 *   ...    ToolStarted/ToolFinished with agent_id -- the subagents working
 *   85.71  AgentNotified idle_prompt    <- "Claude is waiting for your input"
 *  107.42  SubagentFinished   a1e4...      <- eighty seconds after the green tick
 *  109.18  SubagentFinished   a0f2...
 *
 * So the CLI is telling the truth about the MAIN agent and this build was
 * reading it as the truth about the terminal. `TurnFinished` means the person's own
 * agent has finished speaking; it does not mean the work it started is over.
 *
 * The rule is one line and it is the same line for every event that settles:
 * idle is "nobody is running", not "the main agent stopped". Who is running is
 * counted outside this machine (`runningAfter`) and handed in.
 */
describe('a turn that ends while the agents it started are still running', () => {
  const A_SUBAGENT = 'a0f2051a530b4c7a2';
  const ANOTHER = 'a1e499b3f0c990cc8';

  it('goes on working when the main agent stops and a subagent does not', () => {
    expect(machine.apply('working', EVENT_CASES.TurnFinished, [A_SUBAGENT])).toStrictEqual<StateTransition>({
      kind: 'stayed',
      state: 'working',
    });
  });

  it('is idle when the main agent stops and nothing else is running', () => {
    expect(machine.apply('working', EVENT_CASES.TurnFinished, [])).toStrictEqual<StateTransition>({
      kind: 'moved',
      from: 'working',
      to: 'idle',
      signal: 'idle',
    });
  });

  it.each(['AgentNotified:idle_prompt', 'AgentNotified:agent_completed'] as const)(
    'reads %s as work as well, while an agent is running',
    (column) => {
      // Measured at 85.71 s in the run above: the CLI says "Claude is waiting
      // for your input" a full twenty seconds before the subagents finish. It
      // is right about itself and wrong about the terminal.
      expect(machine.apply('working', EVENT_CASES[column], [A_SUBAGENT, ANOTHER])).toStrictEqual<StateTransition>({
        kind: 'stayed',
        state: 'working',
      });
    }
  );

  it('calls the terminal working the moment a subagent starts', () => {
    expect(machine.apply('idle', EVENT_CASES.SubagentStarted, [A_SUBAGENT])).toStrictEqual<StateTransition>({
      kind: 'moved',
      from: 'idle',
      to: 'working',
      signal: 'working',
    });
  });

  it('settles when the last subagent stops and nobody is left', () => {
    // The way out of the working state above. The main agent had stopped long
    // before, so nothing else is ever going to say the turn is over.
    expect(machine.apply('working', EVENT_CASES.SubagentFinished, [])).toStrictEqual<StateTransition>({
      kind: 'moved',
      from: 'working',
      to: 'idle',
      signal: 'idle',
    });
  });

  it('goes on working when one subagent of two stops', () => {
    expect(machine.apply('working', EVENT_CASES.SubagentFinished, [ANOTHER])).toStrictEqual<StateTransition>({
      kind: 'stayed',
      state: 'working',
    });
  });

  it('leaves a terminal that is waiting for the person alone', () => {
    // `waiting_permission` outranks a subagent: the question on the screen is
    // the one the person has to answer, whoever else is running.
    expect(machine.apply('idle', EVENT_CASES.PermissionRequested, [A_SUBAGENT])).toStrictEqual<StateTransition>({
      kind: 'moved',
      from: 'idle',
      to: 'waiting_permission',
      signal: 'waiting_permission',
    });
  });

  it('says nothing new about a terminal that is already over', () => {
    // A subagent hook arriving after the conversation ended is late, exactly as
    // every other hook is.
    for (const event of [EVENT_CASES.SubagentStarted, EVENT_CASES.SubagentFinished]) {
      expect(machine.apply('ended', event, [A_SUBAGENT]).kind).toBe('ignored');
    }
  });
});

describe('what the table alone cannot say', () => {
  it('never calls an unchanged state a move, and never renames the state it left alone', () => {
    const offenders = STATES.flatMap((state) =>
      COLUMNS
        .map((column) => ({ column, transition: machine.apply(state, EVENT_CASES[column]) }))
        .filter(({ transition }) =>
          transition.kind === 'moved'
            ? transition.from !== state || transition.to === state
            : transition.state !== state
        )
        .map(({ column }) => `${state} + ${column}`)
    );

    expect(offenders).toStrictEqual([]);
  });

  it('names the signal after the target state everywhere but one cell', () => {
    // That one cell is the reason `signal` exists at all: bare `ended` is also
    // what a person closing their own terminal produces, so a toast keyed on
    // the state would fire on the user's own deliberate action.
    const renamed = STATES.flatMap((state) =>
      COLUMNS
        .map((column) => ({ column, transition: machine.apply(state, EVENT_CASES[column]) }))
        .filter(({ transition }) => transition.kind === 'moved' && transition.signal !== transition.to)
        .map(({ column, transition }) =>
          transition.kind === 'moved' ? `${state} + ${column} -> ${transition.signal}` : ''
        )
    );

    expect(renamed).toStrictEqual(['launching + LaunchExitedNonZero -> launch_failed']);
  });

  it('lets silence contradict a claim of work, and nothing else', () => {
    // A50, measured 2026-08-20: the CLI sends NOTHING when a turn is
    // interrupted -- none of the thirty-one hooks its binary carries. So a row
    // that says `working` can go on saying it forever, and the only thing that
    // can be said against it is that nothing has arrived. What that buys is
    // narrow and has to stay narrow: silence disproves the CLAIM, it does not
    // establish what replaced it. `degraded` is the state that says exactly
    // that, and `idle` -- which is what the person usually did -- would be a
    // guess about somebody else's program.
    const contradicted = machine.apply('working', wentQuiet());
    const others = STATES
      .filter((state) => state !== 'working')
      .map((state) => machine.apply(state, wentQuiet()));

    expect(contradicted).toStrictEqual({
      kind: 'moved',
      from: 'working',
      to: 'degraded',
      signal: 'degraded',
    });
    expect(others.every((transition) => transition.kind === 'ignored')).toBe(true);
  });

  it('refuses to let a shutdown answer whether a start ever got going', () => {
    // A45, measured 2026-08-20 against CLI 2.1.233: `claude --resume <a
    // conversation that is not there>` prints "No conversation found", sends
    // exactly ONE hook -- `ConversationEnded`, whose `reason` is the same `other` we
    // collapse anything unrecognised into, so the payload does not distinguish
    // it -- and exits with code 1 about 1.6 s LATER. Settling the record as
    // `ended` on that hook means the exit code arrives at a record that is
    // already dead, `resume_failed` never happens, and the offer to start the
    // conversation over (M2.13) is gone from the one path that needs it most.
    //
    // The refusal is this narrow on purpose: `launching` is the only state in
    // which "the CLI shut down" and "the start got going" are different
    // questions. Everywhere else the hook is first-hand evidence and settles
    // the record as it always did.
    const tooEarly = machine.apply('launching', EVENT_CASES.ConversationEnded);
    const elsewhere = STATES
      .filter((state) => state !== 'launching' && !WITNESSED_END.has(state))
      .map((state) => machine.apply(state, EVENT_CASES.ConversationEnded));

    expect(tooEarly.kind).toBe('ignored');
    expect(elsewhere.every((one) => one.kind === 'moved' && one.to === 'ended')).toBe(true);
  });

  it('separates a dropped event from a no-op that was applied', () => {
    // Both leave the state alone. Only one of them is worth a log line, and the
    // reason says which -- `WorkingDirectoryChanged` in `idle` is routine, `TurnFinished` in `ended`
    // is a late delivery, and a duplicate close is a producer bug.
    const routine = machine.apply('idle', EVENT_CASES.WorkingDirectoryChanged);
    const late = machine.apply('ended', EVENT_CASES.TurnFinished);
    const duplicate = machine.apply('ended', EVENT_CASES.TerminalClosed);

    expect(routine.kind).toBe('stayed');
    expect(late.kind).toBe('ignored');
    expect(duplicate.kind).toBe('ignored');
    expect(late.kind === 'ignored' ? late.reason : '').not.toBe(
      duplicate.kind === 'ignored' ? duplicate.reason : ''
    );
  });

  it('gives every dropped event a reason', () => {
    const empty = STATES.flatMap((state) =>
      COLUMNS
        .map((column) => ({ column, transition: machine.apply(state, EVENT_CASES[column]) }))
        .filter(({ transition }) => transition.kind === 'ignored' && transition.reason.length === 0)
        .map(({ column }) => `${state} + ${column}`)
    );

    expect(empty).toStrictEqual([]);
  });
});

describe('the edges that were wrong before', () => {
  it('leaves waiting_permission on every tool event, not only on TurnFinished', () => {
    const columns = ['ToolStarted', 'ToolFinished', 'ToolFailed'] as const;

    expect(columns.map((column) => cellOf(machine.apply('waiting_permission', EVENT_CASES[column]))))
      .toStrictEqual(['working', 'working', 'working']);
  });

  it('reports waiting_permission -> working -> waiting_permission as two moves', () => {
    // M1.11a counts toasts on entry into a state. Without both moves the second
    // permission request of a turn is silently deduplicated away -- the test
    // over there stays green on a mock and lies about the system.
    const out = machine.apply('waiting_permission', EVENT_CASES.ToolFinished);
    const back = machine.apply('working', EVENT_CASES.PermissionRequested);

    expect([out.kind, back.kind]).toStrictEqual(['moved', 'moved']);
  });

  it('keeps a failed launch and a failed restore apart from the same state', () => {
    const launch = machine.apply('launching', EVENT_CASES.LaunchExitedNonZero);
    const resume = machine.apply('launching', EVENT_CASES.ResumeExitedNonZero);

    expect(cellOf(launch)).toBe('ended');
    expect(cellOf(resume)).toBe('resume_failed');
    expect(launch.kind === 'moved' ? launch.signal : null).toBe('launch_failed');
  });

  it('lets a late ConversationStarted clear a resume timeout', () => {
    // The 20 s timeout is a guess about a start that hung. An arriving
    // `ConversationStarted(source: resume)` is the answer it was guessing at, so the
    // guess has to give way -- otherwise a slow machine parks every restored
    // terminal in `degraded` for good.
    const timedOut = machine.apply('launching', EVENT_CASES.ResumeTimedOut);
    const arrived = machine.apply('degraded', {
      kind: 'ConversationStarted',
      source: 'resume',
      ...CONTEXT,
    });

    expect(cellOf(timedOut)).toBe('degraded');
    expect(cellOf(arrived)).toBe('idle');
  });
});

describe('inputs that should never arrive', () => {
  it('refuses an event kind outside the union rather than guessing a state', () => {
    const alien = { kind: 'NotAnEvent' } as unknown as TerminalEvent;

    expect(() => machine.apply('idle', alien)).toThrow(ValidationError);
  });
});
