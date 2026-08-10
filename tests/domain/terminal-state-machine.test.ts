import {
  SessionId,
  TerminalStateMachine,
  ValidationError,
  launchExitedNonZero,
  processGone,
  resumeExitedNonZero,
  resumeTimedOut,
  terminalClosed,
  type HookEventContext,
  type NotificationType,
  type PersistedTerminalState,
  type StateTransition,
  type TerminalEvent,
} from '../../packages/core/src/index';
import { SESSION_UUID } from '../helpers/domain-fixtures';

const CONTEXT: HookEventContext = {
  sessionId: SessionId.fromString(SESSION_UUID),
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

function notification(notificationType: NotificationType): TerminalEvent {
  return { kind: 'Notification', notificationType, message: null, ...CONTEXT };
}

/**
 * The columns of the table.
 *
 * `Notification` is four columns rather than one because its `notificationType`
 * is what chooses the target state -- collapsing it to a single column would
 * hide three of the four behaviours behind whichever type the test happened to
 * pick.
 */
const EVENT_CASES = {
  SessionStart: { kind: 'SessionStart', source: 'startup', ...CONTEXT },
  SessionEnd: { kind: 'SessionEnd', reason: 'logout', ...CONTEXT },
  UserPromptSubmit: { kind: 'UserPromptSubmit', userInput: 'go', ...CONTEXT },
  PreToolUse: { kind: 'PreToolUse', toolName: 'Bash', toolUseId: null, ...CONTEXT },
  PostToolUse: { kind: 'PostToolUse', toolName: 'Bash', toolUseId: null, ...CONTEXT },
  PostToolUseFailure: {
    kind: 'PostToolUseFailure',
    toolName: 'Bash',
    toolUseId: null,
    errorMessage: null,
    ...CONTEXT,
  },
  PermissionRequest: {
    kind: 'PermissionRequest',
    toolName: 'Bash',
    permissionLevel: null,
    ...CONTEXT,
  },
  'Notification:agent_needs_input': notification('agent_needs_input'),
  'Notification:idle_prompt': notification('idle_prompt'),
  'Notification:agent_completed': notification('agent_completed'),
  'Notification:other': notification('auth_success'),
  Stop: { kind: 'Stop', lastAssistantMessage: null, ...CONTEXT },
  StopFailure: { kind: 'StopFailure', errorType: null, errorMessage: null, ...CONTEXT },
  CwdChanged: { kind: 'CwdChanged', oldCwd: null, newCwd: null, ...CONTEXT },
  ResumeTimedOut: resumeTimedOut(),
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
  SessionStart: true,
  SessionEnd: true,
  UserPromptSubmit: true,
  PreToolUse: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PermissionRequest: true,
  Notification: true,
  Stop: true,
  StopFailure: true,
  CwdChanged: true,
  ResumeTimedOut: true,
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
const NOTIFICATION_COLUMN: Record<NotificationType, ColumnName> = {
  agent_needs_input: 'Notification:agent_needs_input',
  idle_prompt: 'Notification:idle_prompt',
  agent_completed: 'Notification:agent_completed',
  auth_success: 'Notification:other',
  computer_use_enter: 'Notification:other',
  computer_use_exit: 'Notification:other',
  elicitation_complete: 'Notification:other',
  elicitation_response: 'Notification:other',
  push_notification: 'Notification:other',
  worker_permission_prompt: 'Notification:other',
  other: 'Notification:other',
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
 * `Stop` was the only edge that ever left. Nothing in the implementation could
 * have flagged that -- but the `waiting_permission` row below has a cell for
 * `PostToolUse`, and an empty one would have been visible.
 *
 * `Record<PersistedTerminalState, Row>` and `Record<ColumnName, Cell>` are what
 * keep it from rotting: a new state or a new event fails to compile until every
 * cell it introduces has been decided.
 */
const TABLE: Record<PersistedTerminalState, Row> = {
  launching: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'launching',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'launching',
    ResumeTimedOut: 'degraded',
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'resume_failed',
  },
  idle: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'idle',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'idle',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  working: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'working',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'working',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  // The row round 10 was missing. Every tool event leaves; `Stop` is not the
  // only exit, and M1.11a's `waiting_permission -> working -> waiting_permission`
  // is a real path rather than a fixture invented for a mock.
  waiting_permission: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'waiting_permission',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'waiting_permission',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  waiting_input: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'waiting_input',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'waiting_input',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  turn_failed: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'turn_failed',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'turn_failed',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  // A witnessed end. The single live cell is `SessionStart`, which is how a
  // terminal gets back out of the `SessionEnd(clear)` that `/clear` sends
  // before it opens the new conversation.
  ended: {
    SessionStart: 'idle',
    SessionEnd: NOT_APPLIED,
    UserPromptSubmit: NOT_APPLIED,
    PreToolUse: NOT_APPLIED,
    PostToolUse: NOT_APPLIED,
    PostToolUseFailure: NOT_APPLIED,
    PermissionRequest: NOT_APPLIED,
    'Notification:agent_needs_input': NOT_APPLIED,
    'Notification:idle_prompt': NOT_APPLIED,
    'Notification:agent_completed': NOT_APPLIED,
    'Notification:other': NOT_APPLIED,
    Stop: NOT_APPLIED,
    StopFailure: NOT_APPLIED,
    CwdChanged: NOT_APPLIED,
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: NOT_APPLIED,
    TerminalClosed: NOT_APPLIED,
    LaunchExitedNonZero: NOT_APPLIED,
    ResumeExitedNonZero: NOT_APPLIED,
  },
  // An inference, not a witness: reconciliation failed to find a process. Any
  // hook disproves it, and the two hooks that carry no phase leave us knowing
  // only that something is alive -- which is `degraded`, spelled out.
  orphaned: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'degraded',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'degraded',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  degraded: {
    SessionStart: 'idle',
    SessionEnd: 'ended',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    PermissionRequest: 'waiting_permission',
    'Notification:agent_needs_input': 'waiting_input',
    'Notification:idle_prompt': 'idle',
    'Notification:agent_completed': 'idle',
    'Notification:other': 'degraded',
    Stop: 'idle',
    StopFailure: 'turn_failed',
    CwdChanged: 'degraded',
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: 'orphaned',
    TerminalClosed: 'ended',
    LaunchExitedNonZero: 'ended',
    ResumeExitedNonZero: 'ended',
  },
  resume_failed: {
    SessionStart: 'idle',
    SessionEnd: NOT_APPLIED,
    UserPromptSubmit: NOT_APPLIED,
    PreToolUse: NOT_APPLIED,
    PostToolUse: NOT_APPLIED,
    PostToolUseFailure: NOT_APPLIED,
    PermissionRequest: NOT_APPLIED,
    'Notification:agent_needs_input': NOT_APPLIED,
    'Notification:idle_prompt': NOT_APPLIED,
    'Notification:agent_completed': NOT_APPLIED,
    'Notification:other': NOT_APPLIED,
    Stop: NOT_APPLIED,
    StopFailure: NOT_APPLIED,
    CwdChanged: NOT_APPLIED,
    ResumeTimedOut: NOT_APPLIED,
    ProcessGone: NOT_APPLIED,
    TerminalClosed: NOT_APPLIED,
    LaunchExitedNonZero: NOT_APPLIED,
    ResumeExitedNonZero: NOT_APPLIED,
  },
};

const STATES = Object.keys(TABLE) as readonly PersistedTerminalState[];
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
            cellOf(machine.apply(state, notification(type as NotificationType))) !==
            cellOf(machine.apply(state, EVENT_CASES[column]))
        )
        .map((state) => `${type} in ${state}`)
    );

    expect(Object.keys(NOTIFICATION_COLUMN)).toHaveLength(11);
    expect(disagreements).toStrictEqual([]);
  });
});

describe.each(STATES)('from %s', (state) => {
  it('lands where the table says, for all nineteen events', () => {
    expect(rowOf(state)).toStrictEqual(TABLE[state]);
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

  it('separates a dropped event from a no-op that was applied', () => {
    // Both leave the state alone. Only one of them is worth a log line, and the
    // reason says which -- `CwdChanged` in `idle` is routine, `Stop` in `ended`
    // is a late delivery, and a duplicate close is a producer bug.
    const routine = machine.apply('idle', EVENT_CASES.CwdChanged);
    const late = machine.apply('ended', EVENT_CASES.Stop);
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
  it('leaves waiting_permission on every tool event, not only on Stop', () => {
    const columns = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const;

    expect(columns.map((column) => cellOf(machine.apply('waiting_permission', EVENT_CASES[column]))))
      .toStrictEqual(['working', 'working', 'working']);
  });

  it('reports waiting_permission -> working -> waiting_permission as two moves', () => {
    // M1.11a counts toasts on entry into a state. Without both moves the second
    // permission request of a turn is silently deduplicated away -- the test
    // over there stays green on a mock and lies about the system.
    const out = machine.apply('waiting_permission', EVENT_CASES.PostToolUse);
    const back = machine.apply('working', EVENT_CASES.PermissionRequest);

    expect([out.kind, back.kind]).toStrictEqual(['moved', 'moved']);
  });

  it('keeps a failed launch and a failed restore apart from the same state', () => {
    const launch = machine.apply('launching', EVENT_CASES.LaunchExitedNonZero);
    const resume = machine.apply('launching', EVENT_CASES.ResumeExitedNonZero);

    expect(cellOf(launch)).toBe('ended');
    expect(cellOf(resume)).toBe('resume_failed');
    expect(launch.kind === 'moved' ? launch.signal : null).toBe('launch_failed');
  });

  it('lets a late SessionStart clear a resume timeout', () => {
    // The 20 s timeout is a guess about a start that hung. An arriving
    // `SessionStart(source: resume)` is the answer it was guessing at, so the
    // guess has to give way -- otherwise a slow machine parks every restored
    // terminal in `degraded` for good.
    const timedOut = machine.apply('launching', EVENT_CASES.ResumeTimedOut);
    const arrived = machine.apply('degraded', {
      kind: 'SessionStart',
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
