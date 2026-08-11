import {
  CONTEXT_LIVE,
  CONTEXT_OVER,
  ContextWindowSnapshot,
  CostSnapshot,
  HumanMetadata,
  ObservedState,
  presentTerminal,
  type PersistedTerminalState,
  type TerminalState,
} from '../../packages/core/src/index';
import { CREATED_AT, OBSERVED_AT, makeEntry } from '../helpers/domain-fixtures';

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
});

describe('presentTerminal lays detached over the stored state', () => {
  it('shows a dead owner as detached without touching the record', () => {
    const entry = inState('working');

    const shown = presentTerminal(entry, 'dead');

    expect(shown.state).toBe<TerminalState>('detached');
    expect(entry.observed.state).toBe('working');
  });

  it('shows a stale heartbeat as detached too', () => {
    // For DRAWING the two are the same answer. They stay apart where it costs
    // something: adoption refuses `unknown` without an explicit force.
    expect(presentTerminal(inState('working'), 'unknown').state).toBe<TerminalState>('detached');
  });

  it('says nothing about detachment when the owner is live', () => {
    expect(presentTerminal(inState('working'), 'live').state).toBe<TerminalState>('working');
  });

  it('offers no actions on a detached terminal', () => {
    expect(presentTerminal(inState('idle'), 'dead').contextValue).toBe(CONTEXT_OVER);
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
