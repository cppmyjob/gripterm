import {
  CONTEXT_FOREIGN,
  CONTEXT_LIVE,
  CONTEXT_OVER,
  ContextWindowSnapshot,
  CostSnapshot,
  HumanMetadata,
  Note,
  ObservedState,
  SessionId,
  presentTerminal,
  type HumanMetadataParams,
  type PersistedTerminalState,
  type TerminalState,
} from '../../packages/core/src/index';
import {
  CREATED_AT,
  NEXT_SESSION_UUID,
  OBSERVED_AT,
  SESSION_UUID,
  makeEntry,
} from '../helpers/domain-fixtures';

/**
 * The list is the product. П1 is not "the extension knows the state" but "the
 * person sees it without asking", so every row below is a way for the list to
 * be drawn and still not answer the question it exists to answer.
 */

const EVERY_STATE: readonly PersistedTerminalState[] = [
  'launching',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
  'turn_failed',
  'ended',
  'orphaned',
  'degraded',
  'resume_failed',
];

function inState(state: PersistedTerminalState, over: Partial<ObservedState> = {}): ReturnType<typeof makeEntry> {
  return makeEntry({
    observed: ObservedState.create({
      state,
      lastEventAt: OBSERVED_AT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
      ...over,
    }),
  });
}

describe('presentTerminal gives every state a face', () => {
  it.each(EVERY_STATE)('names, colours and draws %s', (state) => {
    const shown = presentTerminal(inState(state));

    expect(shown.iconId).not.toBe('');
    expect(shown.description).not.toBe('');
    expect(shown.state).toBe(state);
  });

  it('uses a different icon for every state', () => {
    // A shared icon is a state a person cannot see. The count is asserted
    // against the states, so adding one without an icon fails here rather than
    // arriving on screen wearing another state's face.
    const icons = EVERY_STATE.map((state) => presentTerminal(inState(state)).iconId);

    expect(new Set(icons).size).toBe(EVERY_STATE.length);
  });

  it('spins only while something is happening', () => {
    // A static icon for `working` makes a stuck turn look like a running one,
    // which is the complaint П1 is about.
    const spinning = EVERY_STATE.filter((state) =>
      presentTerminal(inState(state)).iconId.endsWith('~spin')
    );

    expect(spinning).toStrictEqual(['launching', 'working']);
  });

  it('gives the two blocking states one colour, and it is not the working one', () => {
    const permission = presentTerminal(inState('waiting_permission'));
    const input = presentTerminal(inState('waiting_input'));
    const working = presentTerminal(inState('working'));

    expect(permission.colorId).toBe(input.colorId);
    expect(permission.colorId).not.toBe(working.colorId);
  });

  it('lets an ended terminal fade', () => {
    expect(presentTerminal(inState('ended')).colorId).toBe('disabledForeground');
  });
});

describe('presentTerminal marks what a menu may offer', () => {
  it.each(['launching', 'idle', 'working', 'waiting_permission', 'waiting_input', 'turn_failed', 'degraded'] as const)(
    'calls %s a terminal we can still act on',
    (state) => {
      expect(presentTerminal(inState(state)).contextValue).toBe(CONTEXT_LIVE);
    }
  );

  it.each(['ended', 'orphaned', 'resume_failed'] as const)('calls %s over', (state) => {
    // Focusing one of these is a no-op: the terminal object is gone. A menu
    // that offered it would be a promise the command cannot keep.
    expect(presentTerminal(inState(state)).contextValue).toBe(CONTEXT_OVER);
  });

  it('calls a terminal the person closed over, whatever its last state was', () => {
    const closed = makeEntry({ closedAt: new Date(CREATED_AT.getTime() + 1000) });

    expect(closed.observed.state).toBe('idle');
    expect(presentTerminal(closed).contextValue).toBe(CONTEXT_OVER);
  });

  /*
   * A record another window owns and is still using. `focus` would raise
   * nothing and `close` would be a write into a record this window may not
   * write, so the row offers neither -- and says why in the tooltip, because
   * the only other sign is the absence of two buttons.
   */
  it('offers nothing on a working terminal that belongs to another window', () => {
    const shown = presentTerminal(inState('working'), { ours: false });

    expect(shown.contextValue).toBe(CONTEXT_FOREIGN);
    expect(shown.state).toBe<TerminalState>('working');
    expect(shown.tooltipLines).toContain('opened in another window');
  });

  it('says nothing about another window on a row of our own', () => {
    expect(presentTerminal(inState('working')).tooltipLines).not.toContain(
      'opened in another window'
    );
  });

  /*
   * The owner is gone, so this is no longer "somebody else is using it" but
   * "there is something to do here" -- M2.10 restores exactly these.
   */
  it('calls a foreign record whose window has gone over, not foreign', () => {
    expect(
      presentTerminal(inState('working'), { ours: false, liveness: 'dead' }).contextValue
    ).toBe(CONTEXT_OVER);
  });
});

describe('presentTerminal lays detached over the stored state', () => {
  it('shows a dead owner as detached without touching the record', () => {
    const entry = inState('working');

    const shown = presentTerminal(entry, { liveness: 'dead' });

    expect(shown.state).toBe<TerminalState>('detached');
    expect(entry.observed.state).toBe('working');
  });

  it('shows a stale heartbeat as detached too', () => {
    // For DRAWING the two are the same answer. They stay apart where it costs
    // something: adoption refuses `unknown` without an explicit force.
    expect(presentTerminal(inState('working'), { liveness: 'unknown' }).state).toBe<TerminalState>('detached');
  });

  it('says nothing about detachment when the owner is live', () => {
    expect(presentTerminal(inState('working'), { liveness: 'live' }).state).toBe<TerminalState>('working');
  });

  it('offers no actions on a detached terminal', () => {
    expect(presentTerminal(inState('idle'), { liveness: 'dead' }).contextValue).toBe(CONTEXT_OVER);
  });
});

describe('presentTerminal says what the row is about', () => {
  it('takes the label from the person, not from the session', () => {
    expect(presentTerminal(makeEntry()).label).toBe('auth-refactor');
  });

  it('names the running tool beside the state', () => {
    expect(presentTerminal(inState('working', { currentTool: 'Bash' })).description).toBe(
      'working · Bash'
    );
  });

  it('says just the state when no tool is running', () => {
    expect(presentTerminal(inState('working')).description).toBe('working');
  });

  it('carries the task, the folder and the session into the tooltip', () => {
    const lines = presentTerminal(makeEntry()).tooltipLines;

    expect(lines).toContain('Move token validation into its own service');
    expect(lines).toContain('D:/Projects/foo');
    expect(lines.some((line) => line.startsWith('session '))).toBe(true);
  });

  it('leaves out a task nobody wrote', () => {
    const entry = makeEntry({
      metadata: HumanMetadata.create({
        displayName: 'nameless',
        task: null,
        notes: [],
        tags: [],
        color: null,
      }),
    });

    expect(presentTerminal(entry).tooltipLines).toHaveLength(3);
  });

  it('shows the last thing the agent said, flattened onto one line', () => {
    const lines = presentTerminal(
      inState('idle', { lastAssistantMessage: 'done:\n  three files\n  changed' })
    ).tooltipLines;

    expect(lines).toContain('done: three files changed');
  });

  it('cuts a long message rather than letting it become the tooltip', () => {
    const lines = presentTerminal(
      inState('idle', { lastAssistantMessage: 'x'.repeat(500) })
    ).tooltipLines;
    const message = lines.find((line) => line.startsWith('x'));

    expect(message).toHaveLength(161);
    expect(message?.endsWith('…')).toBe(true);
  });

  it('shows cost and context only once something has produced them', () => {
    // Both have exactly one producer, the statusline forwarder (M1.8a). Until
    // it lands they are absent, and an absent number must not be drawn as zero.
    expect(presentTerminal(inState('idle')).tooltipLines.some((l) => l.startsWith('$'))).toBe(false);

    const rich = presentTerminal(
      inState('idle', {
        cost: CostSnapshot.create(1.5, 90_000),
        contextWindow: ContextWindowSnapshot.create(37.4),
      })
    ).tooltipLines;

    expect(rich).toContain('$1.50');
    expect(rich).toContain('context 37%');
  });
});

describe('what the person put on the row', () => {
  const bare: HumanMetadataParams = {
    displayName: 'nameless',
    task: null,
    notes: [],
    tags: [],
    color: null,
  };

  function withMetadata(over: Partial<HumanMetadataParams>): ReturnType<typeof makeEntry> {
    return makeEntry({ metadata: HumanMetadata.create({ ...bare, ...over }) });
  }

  it('shows the tags as one line, marked so the eye can skip it', () => {
    const lines = presentTerminal(withMetadata({ tags: ['backend', 'code review'] })).tooltipLines;

    expect(lines).toContain('#backend #code review');
  });

  it('leaves the line out when there are no tags', () => {
    expect(presentTerminal(withMetadata({})).tooltipLines).toHaveLength(3);
  });

  it('shows the last note on its own, when it is the only one', () => {
    const lines = presentTerminal(
      withMetadata({ notes: [Note.create(CREATED_AT, 'ask about the migration')] })
    ).tooltipLines;

    expect(lines).toContain('ask about the migration');
  });

  it('shows the last note and how many there are, when there are more', () => {
    // A tooltip is a glance. All of them would draw a wall over the list it is
    // a tooltip for, and no count would hide that there is more to read.
    const lines = presentTerminal(
      withMetadata({
        notes: [
          Note.create(CREATED_AT, 'first'),
          Note.create(OBSERVED_AT, 'second'),
          Note.create(OBSERVED_AT, 'third'),
        ],
      })
    ).tooltipLines;

    expect(lines).toContain('third (3 notes)');
    expect(lines).not.toContain('first');
  });

  it('cuts a long note by the same rule it cuts the agent', () => {
    const lines = presentTerminal(
      withMetadata({ notes: [Note.create(CREATED_AT, 'y'.repeat(500))] })
    ).tooltipLines;

    expect(lines.some((line) => line.endsWith('…') && line.length < 200)).toBe(true);
  });

  it('hands the colour out for the label, and never for the icon', () => {
    // Two colours, two surfaces. The icon answers "does this one need me", and
    // a personal colour laid over it would trade the row's only automatic
    // signal for a manual one.
    const shown = presentTerminal(withMetadata({ color: 'terminal.ansiMagenta' }));

    expect(shown.labelColorId).toBe('terminal.ansiMagenta');
    expect(shown.colorId).not.toBe('terminal.ansiMagenta');
  });

  it('leaves the label alone when the person chose no colour', () => {
    expect(presentTerminal(withMetadata({})).labelColorId).toBeNull();
  });

  it('keeps the colour on a row that is over, because filing outlives the terminal', () => {
    const shown = presentTerminal(
      makeEntry({
        metadata: HumanMetadata.create({ ...bare, color: 'terminal.ansiCyan' }),
        closedAt: OBSERVED_AT,
      })
    );

    expect(shown.contextValue).toBe(CONTEXT_OVER);
    expect(shown.labelColorId).toBe('terminal.ansiCyan');
  });
});

describe('a terminal whose conversation has been replaced', () => {
  const THIRD_UUID = '7f4d2a1c-5b6e-4c8a-9d0f-1a2b3c4d5e6f';

  function cleared(...history: readonly string[]): ReturnType<typeof makeEntry> {
    return makeEntry({
      sessionId: SessionId.fromString(NEXT_SESSION_UUID),
      sessionIdHistory: history.map((id) => SessionId.fromString(id)),
    });
  }

  it('names the conversation it is having now', () => {
    expect(presentTerminal(cleared(SESSION_UUID)).tooltipLines).toContain(
      `session ${NEXT_SESSION_UUID}`
    );
  });

  it('names the one it left, in full, because that is the way back to it', () => {
    // `/clear` does not delete anything: the conversation is still in the CLI's
    // own store and `claude --resume <id>` still reaches it. The id is the only
    // handle on it a person has, so it is shown whole rather than shortened --
    // this is a line to copy, not to read.
    expect(presentTerminal(cleared(SESSION_UUID)).tooltipLines).toContain(
      `previously ${SESSION_UUID}`
    );
  });

  it('counts the older ones instead of listing them', () => {
    expect(presentTerminal(cleared(THIRD_UUID, SESSION_UUID)).tooltipLines).toContain(
      `previously ${SESSION_UUID} (+1 more)`
    );
  });

  it('says nothing at all about a terminal still in its first conversation', () => {
    expect(
      presentTerminal(makeEntry()).tooltipLines.some((line) => line.startsWith('previously '))
    ).toBe(false);
  });
});
