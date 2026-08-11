import { ObservedState, summariseTerminals } from '../../packages/core/src/index';
import { CREATED_AT, OBSERVED_AT, makeEntry } from '../helpers/domain-fixtures';
import type { PersistedTerminalState, TerminalEntry } from '../../packages/core/src/index';

function inState(state: PersistedTerminalState, index = 0): TerminalEntry {
  return makeEntry({
    terminalId: {
      value: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    } as never,
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

describe('summariseTerminals answers one question', () => {
  it('shows nothing when this window is running nothing', () => {
    // A status bar slot occupied in every window, saying zero, is the behaviour
    // people uninstall extensions for.
    expect(summariseTerminals([])).toBeNull();
  });

  it('leads with what is waiting for the person', () => {
    const summary = summariseTerminals([
      inState('working', 1),
      inState('waiting_permission', 2),
      inState('idle', 3),
    ]);

    expect(summary?.text).toBe('$(shield) 1 waiting for you');
    expect(summary?.alert).toBe(true);
  });

  it('counts both blocking states as waiting', () => {
    const summary = summariseTerminals([
      inState('waiting_permission', 1),
      inState('waiting_input', 2),
    ]);

    expect(summary?.text).toBe('$(shield) 2 waiting for you');
  });

  it('falls back to what is running when nothing is blocked', () => {
    const summary = summariseTerminals([inState('working', 1), inState('idle', 2)]);

    expect(summary?.text).toBe('$(sync~spin) 1 working');
    expect(summary?.alert).toBe(false);
  });

  it('counts a starting terminal as running', () => {
    expect(summariseTerminals([inState('launching', 1)])?.text).toBe('$(sync~spin) 1 working');
  });

  it('says so when everything is quiet', () => {
    const summary = summariseTerminals([inState('idle', 1), inState('idle', 2)]);

    expect(summary?.text).toBe('$(check) 2 idle');
    expect(summary?.alert).toBe(false);
  });
});

describe('summariseTerminals leaves out what is over', () => {
  it.each(['ended', 'orphaned', 'resume_failed'] as const)('does not count %s', (state) => {
    expect(summariseTerminals([inState(state, 1)])).toBeNull();
  });

  it('does not count a terminal the person closed', () => {
    const closed = makeEntry({ closedAt: new Date(CREATED_AT.getTime() + 1000) });

    expect(summariseTerminals([closed])).toBeNull();
  });

  it('still counts a degraded terminal, which is alive and merely unreadable', () => {
    expect(summariseTerminals([inState('degraded', 1)])?.text).toBe('$(check) 1 idle');
  });
});

describe('summariseTerminals puts the detail where someone has stopped to look', () => {
  it('tallies the states in the tooltip, most numerous first', () => {
    const summary = summariseTerminals([
      inState('working', 1),
      inState('working', 2),
      inState('waiting_permission', 3),
    ]);

    expect(summary?.tooltipLines).toStrictEqual(['2 working', '1 waiting permission']);
  });

  it('breaks a tie by name, so the tooltip does not reshuffle itself', () => {
    const summary = summariseTerminals([inState('working', 1), inState('idle', 2)]);

    expect(summary?.tooltipLines).toStrictEqual(['1 idle', '1 working']);
  });
});
