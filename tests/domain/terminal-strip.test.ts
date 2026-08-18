import {
  ATTENTION_STATES,
  ObservedState,
  TerminalId,
  stripTabs,
  type PersistedTerminalState,
  type StripTab,
  type TerminalEntry,
} from '../../packages/core/src/index';
import { OBSERVED_AT, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

/**
 * The strip is what a person switches agents with, so every line below is a way
 * for it to be drawn and still lie: a tab in the wrong order is one somebody
 * clicks by muscle memory, a mark on the tab being read is a mark that means
 * nothing, and a tab that vanishes is a terminal that cannot be closed.
 */

const OTHER_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const THIRD_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function inState(terminalId: string, state: PersistedTerminalState): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(terminalId),
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

function tabFor(tabs: readonly StripTab[], terminalId: string): StripTab {
  const found = tabs.find((tab) => tab.terminalId === terminalId);
  if (found === undefined) {
    throw new Error(`no tab for ${terminalId}`);
  }
  return found;
}

describe('the strip is drawn from what the panel holds', () => {
  it('keeps the order the panel took them in, whatever order the records arrive in', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      running: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      active: TERMINAL_UUID,
      entries: [inState(THIRD_UUID, 'idle'), inState(TERMINAL_UUID, 'idle')],
    });

    expect(tabs.map((tab) => tab.terminalId)).toEqual([TERMINAL_UUID, OTHER_UUID, THIRD_UUID]);
  });

  it('marks exactly one tab as the one on screen', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID, OTHER_UUID],
      running: [TERMINAL_UUID, OTHER_UUID],
      active: OTHER_UUID,
      entries: [inState(TERMINAL_UUID, 'idle'), inState(OTHER_UUID, 'idle')],
    });

    expect(tabs.filter((tab) => tab.active).map((tab) => tab.terminalId)).toEqual([OTHER_UUID]);
  });

  it('gives every tab the face the list gives the same terminal', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [TERMINAL_UUID],
      active: null,
      entries: [inState(TERMINAL_UUID, 'working')],
    });

    // The modifier travels WHOLE. Splitting it here would put the rule that
    // turns it into two CSS classes in two places, and the page's copy is the
    // one nobody would notice going wrong -- an icon that is simply not drawn.
    expect(tabFor(tabs, TERMINAL_UUID).iconId).toBe('sync~spin');
    expect(tabFor(tabs, TERMINAL_UUID).colorId).toBe('charts.blue');
    expect(tabFor(tabs, TERMINAL_UUID).label).toBe('auth-refactor');
  });

  it('leaves the colour to the page when the state has none of its own', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [],
      active: null,
      entries: [inState(TERMINAL_UUID, 'ended')],
    });

    expect(tabFor(tabs, TERMINAL_UUID).iconId).toBe('circle-slash');
    expect(tabFor(tabs, TERMINAL_UUID).colorId).toBe('disabledForeground');
  });
});

describe('the mark of a terminal that is waiting for a person', () => {
  it.each(ATTENTION_STATES)('is on a tab in %s that is not the one being read', (state) => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [TERMINAL_UUID],
      active: null,
      entries: [inState(TERMINAL_UUID, state as PersistedTerminalState)],
    });

    expect(tabFor(tabs, TERMINAL_UUID).attention).toBe(true);
  });

  it.each(ATTENTION_STATES)('is not on the tab being read, even in %s', (state) => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [TERMINAL_UUID],
      active: TERMINAL_UUID,
      entries: [inState(TERMINAL_UUID, state as PersistedTerminalState)],
    });

    // The owner's rule: the mark goes out when you switch to it. Written as a
    // function of the state rather than as a flag cleared on a click, so a
    // person who switches away from an agent that is STILL waiting gets it back.
    expect(tabFor(tabs, TERMINAL_UUID).attention).toBe(false);
  });

  it('is not on a tab whose agent is working, however busy it is', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [TERMINAL_UUID],
      active: null,
      entries: [inState(TERMINAL_UUID, 'working')],
    });

    expect(tabFor(tabs, TERMINAL_UUID).attention).toBe(false);
  });

  it('names the two states an agent stops in, and no others', () => {
    // A list that grew a third member would be a mark on tabs nobody decided
    // about, which is how a signal stops meaning anything.
    expect([...ATTENTION_STATES]).toEqual(['waiting_permission', 'waiting_input']);
  });
});

describe('a terminal whose process has gone', () => {
  it('keeps its tab, and the tab says the process is gone', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID, OTHER_UUID],
      running: [OTHER_UUID],
      active: OTHER_UUID,
      entries: [inState(TERMINAL_UUID, 'idle'), inState(OTHER_UUID, 'idle')],
    });

    // The owner's decision of 2026-08-18: what an agent printed on its way out
    // is the whole of what is left to read, so the tab waits for the cross.
    expect(tabFor(tabs, TERMINAL_UUID).over).toBe(true);
    expect(tabFor(tabs, OTHER_UUID).over).toBe(false);
  });

  it('is over because the panel has no process for it, not because a record says so', () => {
    // The two answers differ, and this is the case where: the record still says
    // `working` -- a hook that never arrived, a window that lost the base -- and
    // the process is gone all the same. The panel's own knowledge wins, because
    // it is the one that cannot be stale.
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [],
      active: null,
      entries: [inState(TERMINAL_UUID, 'working')],
    });

    expect(tabFor(tabs, TERMINAL_UUID).over).toBe(true);
  });
});

describe('a terminal the panel holds and no record describes', () => {
  it('still gets a tab, so that it can be reached and closed', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [TERMINAL_UUID],
      active: TERMINAL_UUID,
      entries: [],
    });

    expect(tabs).toHaveLength(1);
    expect(tabFor(tabs, TERMINAL_UUID).label).toBe('terminal');
    expect(tabFor(tabs, TERMINAL_UUID).iconId).toBe('question');
    expect(tabFor(tabs, TERMINAL_UUID).colorId).toBeNull();
    expect(tabFor(tabs, TERMINAL_UUID).attention).toBe(false);
  });

  it('says the process is gone when it is, even with nothing to describe it', () => {
    const tabs = stripTabs({
      held: [TERMINAL_UUID],
      running: [],
      active: null,
      entries: [],
    });

    expect(tabFor(tabs, TERMINAL_UUID).iconId).toBe('circle-slash');
    expect(tabFor(tabs, TERMINAL_UUID).over).toBe(true);
  });
});

describe('a panel holding nothing', () => {
  it('draws no strip at all', () => {
    expect(stripTabs({ held: [], running: [], active: null, entries: [] })).toEqual([]);
  });
});
