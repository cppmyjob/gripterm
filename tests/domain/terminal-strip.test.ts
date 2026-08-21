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
  it('draws a tab for every held terminal, whatever order the records arrive in', () => {
    /*
     * The order this used to assert -- "the order the panel took them in" -- is
     * no longer the promise (owner's decision 2026-08-21, see the last describe
     * of this file). What survives from it, and is the reason the test stays, is
     * the other half: the order the RECORDS arrive in decides nothing, and a
     * held terminal with no record among them still gets a tab.
     */
    const tabs = stripTabs({
      held: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      running: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      active: TERMINAL_UUID,
      entries: [inState(THIRD_UUID, 'idle'), inState(TERMINAL_UUID, 'idle')],
    });
    const backwards = stripTabs({
      held: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      running: [TERMINAL_UUID, OTHER_UUID, THIRD_UUID],
      active: TERMINAL_UUID,
      entries: [inState(TERMINAL_UUID, 'idle'), inState(THIRD_UUID, 'idle')],
    });

    expect(tabs.map((tab) => tab.terminalId).sort()).toEqual(
      [TERMINAL_UUID, OTHER_UUID, THIRD_UUID].sort()
    );
    expect(backwards.map((tab) => tab.terminalId)).toEqual(tabs.map((tab) => tab.terminalId));
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

/**
 * The order the tabs stand in (owner's decision 2026-08-21).
 *
 * The strip used to draw them in the order the PANEL took them, which after a
 * restart is the order the store handed the records over -- and that is the
 * order the filesystem lists uuid-named directories in, which is no order at
 * all. The owner watched terminal 2 come back in front of terminal 1 and could
 * not drag it back, because the tabs did not drag.
 *
 * The arrangement now decides, and it lives on the record (`placement`), so the
 * strip and the tree draw the same one and a restart cannot change it.
 */
describe('the order the tabs stand in', () => {
  const placed = (terminalId: string, madeAtMs: number, order: number | null): TerminalEntry => {
    const entry = makeEntry({
      terminalId: TerminalId.fromString(terminalId),
      createdAt: new Date(madeAtMs),
    });
    return order === null ? entry : entry.withOrder(order);
  };

  it('follows the arrangement, not the order the panel took them in', () => {
    const first = placed(TERMINAL_UUID, 1000, 3000);
    const second = placed(OTHER_UUID, 2000, 1000);

    const tabs = stripTabs({
      // The panel took them in this order and the person arranged them in the
      // other one. The person wins.
      held: [TERMINAL_UUID, OTHER_UUID],
      running: [TERMINAL_UUID, OTHER_UUID],
      active: null,
      entries: [first, second],
    });

    expect(tabs.map((tab) => tab.terminalId)).toStrictEqual([OTHER_UUID, TERMINAL_UUID]);
  });

  it('falls back to when each terminal was made, which is the order they appeared', () => {
    const older = placed(TERMINAL_UUID, 1000, null);
    const newer = placed(OTHER_UUID, 2000, null);

    const tabs = stripTabs({
      held: [OTHER_UUID, TERMINAL_UUID],
      running: [OTHER_UUID, TERMINAL_UUID],
      active: null,
      entries: [newer, older],
    });

    expect(tabs.map((tab) => tab.terminalId)).toStrictEqual([TERMINAL_UUID, OTHER_UUID]);
  });

  it('keeps a held terminal no record describes, and puts it last', () => {
    // It is a defect somewhere else if this happens, and the tab still has to be
    // there -- a screen on the stack with no tab is a terminal a person cannot
    // reach. Last, because there is nothing to sort it by, and guessing a place
    // for it would move the tabs that do have one.
    const known = placed(TERMINAL_UUID, 5000, null);

    const tabs = stripTabs({
      held: [THIRD_UUID, TERMINAL_UUID],
      running: [THIRD_UUID, TERMINAL_UUID],
      active: null,
      entries: [known],
    });

    expect(tabs.map((tab) => tab.terminalId)).toStrictEqual([TERMINAL_UUID, THIRD_UUID]);
  });
});
