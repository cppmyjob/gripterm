import {
  ContextWindowSnapshot,
  CostSnapshot,
  DETAILS_EVENT_LIMIT,
  HumanMetadata,
  Note,
  ObservedState,
  SessionId,
  TerminalId,
  describeTerminal,
  presentTerminal,
  type DetailsInput,
  type HistoryEvent,
  type TerminalEntry,
  type TerminalEvent,
} from '../../packages/core/src/index';
import { CREATED_AT, OBSERVED_AT, SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

/**
 * The details half is the only surface in this build that claims to say what
 * Gripterm KNOWS, so every line below is a way for it to be drawn and still
 * mislead: a half that describes a terminal other than the one on screen, a
 * history with a hole in it drawn as an unbroken one, an event this build
 * cannot read left out silently, or a blank rectangle where "there is nothing
 * here" was meant.
 */

const OTHER_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NEXT_SESSION = '44a6e703-2b4c-4d6f-8a91-1e2f3a4b5c6d';
const OLDER_SESSION = '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

/** The read that a terminal with an ordinary, whole, readable history produces. */
function history(events: readonly HistoryEvent[] = []): DetailsInput['history'] {
  return { events, gaps: 0, unreadableLines: 0, unreadableFiles: 0, read: true };
}

function at(event: TerminalEvent, atMs = 1_700_000_000_000, dropped: readonly string[] = []): HistoryEvent {
  return { atMs, event, dropped };
}

/** A hook event with the fields every one of them carries. */
function hookContext(): {
  sessionId: SessionId;
  promptId: null;
  cwd: null;
  transcriptPath: null;
} {
  return {
    sessionId: SessionId.fromString(SESSION_UUID),
    promptId: null,
    cwd: null,
    transcriptPath: null,
  };
}

function shownAlone(entry: TerminalEntry, events: readonly HistoryEvent[] = []): DetailsInput {
  return {
    held: [entry.terminalId.value],
    shown: entry.terminalId.value,
    running: [entry.terminalId.value],
    entries: [entry],
    history: history(events),
  };
}

function factValue(view: ReturnType<typeof describeTerminal>, name: string): string | null {
  return view.facts.find((fact) => fact.name === name)?.value ?? null;
}

describe('the details half says which terminal it is about', () => {
  it('describes the terminal on screen and not the first one the panel holds', () => {
    const first = makeEntry();
    const second = makeEntry({
      terminalId: TerminalId.fromString(OTHER_UUID),
      metadata: HumanMetadata.create({
        displayName: 'the one on screen',
        task: null,
        notes: [],
        tags: [],
        color: null,
      }),
    });

    const view = describeTerminal({
      held: [TERMINAL_UUID, OTHER_UUID],
      shown: OTHER_UUID,
      running: [TERMINAL_UUID, OTHER_UUID],
      entries: [first, second],
      history: history(),
    });

    expect(view.headline?.terminalId).toBe(OTHER_UUID);
    expect(view.headline?.label).toBe('the one on screen');
  });

  it('draws the state exactly as the tree and the strip draw it', () => {
    const entry = makeEntry({
      observed: ObservedState.create({
        state: 'waiting_permission',
        lastEventAt: OBSERVED_AT,
        currentTool: 'Bash',
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      }),
    });
    const shown = presentTerminal(entry);

    const view = describeTerminal(shownAlone(entry));

    expect(view.headline?.iconId).toBe(shown.iconId);
    expect(view.headline?.colorId).toBe(shown.colorId);
    expect(view.headline?.words).toBe('waiting for permission');
  });

  it('says a terminal is over rather than leaving it looking alive', () => {
    const entry = makeEntry({
      observed: ObservedState.create({
        state: 'ended',
        lastEventAt: OBSERVED_AT,
        currentTool: null,
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      }),
    });

    const view = describeTerminal({
      held: [TERMINAL_UUID],
      shown: TERMINAL_UUID,
      running: [],
      entries: [entry],
      history: history(),
    });

    expect(view.nothing).toBeNull();
    expect(view.headline?.over).toBe(true);
    expect(view.headline?.words).toBe('ended');
  });
});

describe('the details half draws its empty states rather than a blank rectangle', () => {
  it('says what to do when the panel holds no terminal at all', () => {
    const view = describeTerminal({
      held: [],
      shown: null,
      running: [],
      entries: [],
      history: history(),
    });

    expect(view.nothing).toContain('New Terminal');
    expect(view.headline).toBeNull();
    expect(view.facts).toEqual([]);
    expect(view.events).toEqual([]);
    expect(view.notes).toEqual([]);
    expect(view.notices).toEqual([]);
    expect(view.task).toBeNull();
  });

  it('says so when the panel holds terminals and shows none of them', () => {
    const view = describeTerminal({
      held: [TERMINAL_UUID],
      shown: null,
      running: [TERMINAL_UUID],
      entries: [makeEntry()],
      history: history(),
    });

    expect(view.nothing).toContain('tab');
    expect(view.headline).toBeNull();
  });

  it('still names a terminal the window holds but has no record of', () => {
    const view = describeTerminal({
      held: [TERMINAL_UUID],
      shown: TERMINAL_UUID,
      running: [TERMINAL_UUID],
      entries: [],
      history: history(),
    });

    expect(view.nothing).toBeNull();
    expect(view.headline?.terminalId).toBe(TERMINAL_UUID);
    expect(view.facts).toEqual([]);
    expect(view.notices.join(' ')).toContain('no record');
  });
});

describe('the details half shows what the registry knows and nothing it does not', () => {
  it('lays out the facts a person asks about, in one order', () => {
    const entry = makeEntry({
      sessionId: SessionId.fromString(SESSION_UUID),
      sessionIdHistory: [SessionId.fromString(OLDER_SESSION), SessionId.fromString(NEXT_SESSION)],
      observed: ObservedState.create({
        state: 'working',
        lastEventAt: OBSERVED_AT,
        currentTool: 'Edit',
        lastAssistantMessage: 'the tests pass',
        cost: CostSnapshot.create(1.5, 1000),
        contextWindow: ContextWindowSnapshot.create(37.4),
        pid: 4242,
      }),
    });

    const view = describeTerminal(shownAlone(entry));

    expect(view.facts.map((fact) => fact.name)).toEqual([
      'tool',
      'folder',
      'process',
      'engine',
      'cost',
      'context',
      'last answer',
      'session',
      'previously',
    ]);
    expect(factValue(view, 'tool')).toBe('Edit');
    expect(factValue(view, 'folder')).toBe('D:/Projects/foo');
    expect(factValue(view, 'process')).toBe('4242');
    expect(factValue(view, 'engine')).toBe('editor');
    expect(factValue(view, 'cost')).toBe('$1.50');
    expect(factValue(view, 'context')).toBe('37% used');
    expect(factValue(view, 'last answer')).toBe('the tests pass');
    expect(factValue(view, 'session')).toBe(SESSION_UUID);
    expect(factValue(view, 'previously')).toBe(`${NEXT_SESSION} (+1 more)`);
    expect(view.startedAtMs).toBe(CREATED_AT.getTime());
    expect(view.lastEventAtMs).toBe(OBSERVED_AT.getTime());
  });

  it('leaves out every fact the record does not carry', () => {
    const view = describeTerminal(shownAlone(makeEntry()));

    expect(view.facts.map((fact) => fact.name)).toEqual(['folder', 'engine', 'session']);
  });

  it('shows the one previous conversation without counting it twice', () => {
    const entry = makeEntry({ sessionIdHistory: [SessionId.fromString(NEXT_SESSION)] });

    expect(factValue(describeTerminal(shownAlone(entry)), 'previously')).toBe(NEXT_SESSION);
  });

  it('cuts a long answer rather than letting it become the half', () => {
    const entry = makeEntry({
      observed: ObservedState.create({
        state: 'idle',
        lastEventAt: OBSERVED_AT,
        currentTool: null,
        lastAssistantMessage: 'x'.repeat(1000),
        cost: null,
        contextWindow: null,
        pid: null,
      }),
    });

    const answer = factValue(describeTerminal(shownAlone(entry)), 'last answer') ?? '';

    expect(answer.length).toBeLessThan(1000);
    expect(answer.endsWith('…')).toBe(true);
  });

  it('shows the task and the notes, newest note first', () => {
    const entry = makeEntry({
      metadata: HumanMetadata.create({
        displayName: 'auth-refactor',
        task: 'Move token validation',
        notes: [
          Note.create(new Date('2026-08-01T10:00:00.000Z'), 'the older one'),
          Note.create(new Date('2026-08-02T10:00:00.000Z'), 'the newer one'),
        ],
        tags: [],
        color: null,
      }),
    });

    const view = describeTerminal(shownAlone(entry));

    expect(view.task).toBe('Move token validation');
    expect(view.notes.map((note) => note.text)).toEqual(['the newer one', 'the older one']);
    expect(view.notes[0]?.atMs).toBe(new Date('2026-08-02T10:00:00.000Z').getTime());
  });
});

describe('the history is shown as what it is, holes included', () => {
  it('turns every event this build has into words of its own', () => {
    const context = hookContext();
    const events: readonly TerminalEvent[] = [
      { ...context, kind: 'SessionStart', source: 'resume' },
      { ...context, kind: 'SessionEnd', reason: 'clear' },
      { ...context, kind: 'UserPromptSubmit', userInput: null },
      { ...context, kind: 'PreToolUse', toolName: 'Bash', toolUseId: null },
      { ...context, kind: 'PostToolUse', toolName: 'Bash', toolUseId: null },
      {
        ...context,
        kind: 'PostToolUseFailure',
        toolName: 'Bash',
        toolUseId: null,
        errorMessage: null,
      },
      { ...context, kind: 'PermissionRequest', toolName: 'Bash', permissionLevel: null },
      { ...context, kind: 'Notification', notificationType: 'idle_prompt', message: null },
      { ...context, kind: 'Stop', lastAssistantMessage: null },
      { ...context, kind: 'StopFailure', errorType: 'overloaded', errorMessage: null },
      { ...context, kind: 'CwdChanged', oldCwd: null, newCwd: 'D:/Projects/bar' },
      { kind: 'ResumeTimedOut' },
      { kind: 'ProcessGone', pid: 4242 },
      { kind: 'TerminalClosed' },
      { kind: 'LaunchExitedNonZero', exitCode: 1 },
      { kind: 'ResumeExitedNonZero', exitCode: 2 },
    ];

    const view = describeTerminal(shownAlone(makeEntry(), events.map((event) => at(event))));

    expect(view.events.map((event) => event.words)).toEqual([
      'conversation started (resume)',
      'conversation ended (clear)',
      'you sent a prompt',
      'Bash started',
      'Bash finished',
      'Bash failed',
      'asked to run Bash',
      'notification: idle_prompt',
      'turn finished',
      'turn failed (overloaded)',
      'working directory changed',
      'restoring took too long',
      'the process is gone',
      'the terminal was closed',
      'the start exited with 1',
      'the restore exited with 2',
    ]);
  });

  it('says a tool ran even when the payload never named it', () => {
    const context = hookContext();

    const view = describeTerminal(
      shownAlone(makeEntry(), [
        at({ ...context, kind: 'PreToolUse', toolName: null, toolUseId: null }),
        at({ ...context, kind: 'PostToolUse', toolName: null, toolUseId: null }),
        at({
          ...context,
          kind: 'PostToolUseFailure',
          toolName: null,
          toolUseId: null,
          errorMessage: null,
        }),
        at({ ...context, kind: 'PermissionRequest', toolName: null, permissionLevel: null }),
        at({ ...context, kind: 'StopFailure', errorType: null, errorMessage: null }),
      ])
    );

    expect(view.events.map((event) => event.words)).toEqual([
      'a tool started',
      'a tool finished',
      'a tool failed',
      'asked for permission',
      'turn failed',
    ]);
  });

  it('draws a line it cannot read rather than dropping it', () => {
    const view = describeTerminal(shownAlone(makeEntry(), [{ atMs: 1, event: null, dropped: [] }]));

    expect(view.events).toHaveLength(1);
    expect(view.events[0]?.words).toContain('cannot read');
  });

  it('keeps the newest events when the history is longer than the half shows', () => {
    const context = hookContext();
    const many = Array.from({ length: DETAILS_EVENT_LIMIT + 5 }, (_, index) =>
      at({ ...context, kind: 'PreToolUse', toolName: `tool-${String(index)}`, toolUseId: null }, index)
    );

    const view = describeTerminal(shownAlone(makeEntry(), many));

    expect(view.events).toHaveLength(DETAILS_EVENT_LIMIT);
    expect(view.events[0]?.words).toBe('tool-5 started');
    expect(view.events.at(-1)?.words).toBe(`tool-${String(DETAILS_EVENT_LIMIT + 4)} started`);
  });

  it('names a hole in the numbering instead of drawing an unbroken history', () => {
    const view = describeTerminal({
      ...shownAlone(makeEntry()),
      history: { events: [], gaps: 2, unreadableLines: 0, unreadableFiles: 0, read: true },
    });

    expect(view.notices.join(' ')).toContain('2');
    expect(view.notices.join(' ')).toContain('missing');
  });

  it('counts what could not be read, lines and files apart', () => {
    const view = describeTerminal({
      ...shownAlone(makeEntry()),
      history: { events: [], gaps: 0, unreadableLines: 3, unreadableFiles: 1, read: true },
    });

    expect(view.notices.some((notice) => notice.includes('3') && notice.includes('lines'))).toBe(true);
    expect(view.notices.some((notice) => notice.includes('1') && notice.includes('file'))).toBe(true);
  });

  it('says that the texts are missing by policy rather than by accident', () => {
    const context = hookContext();

    const view = describeTerminal(
      shownAlone(makeEntry(), [
        at({ ...context, kind: 'UserPromptSubmit', userInput: null }, 1, ['prompt']),
      ])
    );

    expect(view.notices.join(' ')).toContain('includeContent');
  });

  it('says an empty journal is empty, and an unread one unread', () => {
    const empty = describeTerminal(shownAlone(makeEntry()));
    const unread = describeTerminal({
      ...shownAlone(makeEntry()),
      history: { events: [], gaps: 0, unreadableLines: 0, unreadableFiles: 0, read: false },
    });

    expect(empty.notices.join(' ')).toContain('Nothing has been written');
    expect(unread.notices.join(' ')).toContain('Reading');
  });
});
