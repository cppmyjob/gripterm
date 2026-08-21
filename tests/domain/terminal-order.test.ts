import { TerminalId, arranged, reorderTerminals } from '../../packages/core/src/index';
import { makeEntry } from '../helpers/domain-fixtures';
import type { TerminalEntry } from '../../packages/core/src/index';

/**
 * The order the tabs of the panel stand in, and the fact that a person may
 * change it.
 *
 * **Why this exists at all.** The owner, 2026-08-21: "после перезагрузки
 * меняется порядок табов терминалов... сначала идёт таб с терминалом 2 а потом
 * 1". The cause was that nothing HELD an order. The store answers `readAll` in
 * the order the filesystem lists directories -- their names are uuids -- the
 * restore walks that list, and the panel takes the terminals in the order they
 * came back. Two runs could disagree and nobody could correct them.
 *
 * The owner's decision, same day: the order lives IN THE RECORD (so it survives
 * a restart and travels with the record to whichever window adopts it), and it
 * applies to the tab strip AND to the tree.
 *
 * **Why the value defaults to the moment of creation.** A record written before
 * this field existed has no arrangement, and "when it was made" is the only
 * honest answer to where it belongs -- it is also the order the person saw the
 * tabs appear in. That makes ONE number space for both kinds of record, so a
 * drag between an arranged tab and an unarranged one is an ordinary comparison
 * rather than a special case.
 */

const MINUTE = 60_000;
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

function tab(id: string, madeAtMs: number, order: number | null = null): TerminalEntry {
  const entry = makeEntry({
    terminalId: TerminalId.fromString(id),
    createdAt: new Date(madeAtMs),
  });
  return order === null ? entry : entry.withOrder(order);
}

/** The ids, in the order the panel would draw them. */
function ids(entries: readonly TerminalEntry[]): string[] {
  return arranged(entries).map((entry) => entry.terminalId.value);
}

/** The list as it stands after a drag has been applied to it. */
function afterMove(
  entries: readonly TerminalEntry[],
  moved: string,
  toIndex: number
): readonly TerminalEntry[] {
  const changed = reorderTerminals({
    entries,
    moved: TerminalId.fromString(moved),
    toIndex,
  });
  const byId = new Map(changed.map((entry) => [entry.terminalId.value, entry]));
  return entries.map((entry) => byId.get(entry.terminalId.value) ?? entry);
}

describe('the order the tabs stand in', () => {
  it('is the order they were made in, until somebody says otherwise', () => {
    const late = tab(THIRD, 3 * MINUTE);
    const early = tab(FIRST, 1 * MINUTE);
    const middle = tab(SECOND, 2 * MINUTE);

    // The defect itself: the store hands them over in the order the filesystem
    // lists uuid-named directories, which is no order at all.
    expect(ids([late, early, middle])).toStrictEqual([FIRST, SECOND, THIRD]);
  });

  it('puts an arranged tab where it was put, among ones nobody arranged', () => {
    const early = tab(FIRST, 1 * MINUTE);
    const middle = tab(SECOND, 2 * MINUTE);
    const dragged = tab(THIRD, 3 * MINUTE, 90_000 - 1);

    expect(ids([early, middle, dragged])).toStrictEqual([FIRST, THIRD, SECOND]);
  });

  it('breaks a tie the same way twice, so two windows agree', () => {
    // Same order, same creation moment: without a last resort the answer would
    // depend on which record the filesystem happened to list first.
    const one = tab(FIRST, MINUTE, 5);
    const two = tab(SECOND, MINUTE, 5);

    expect(ids([two, one])).toStrictEqual(ids([one, two]));
  });
});

describe('dragging a tab', () => {
  const three = [tab(FIRST, MINUTE), tab(SECOND, 2 * MINUTE), tab(THIRD, 3 * MINUTE)];

  it('moves it to the front and writes ONE record', () => {
    const changed = reorderTerminals({
      entries: three,
      moved: TerminalId.fromString(THIRD),
      toIndex: 0,
    });

    // One write, and that is the whole reason the value is a number on a line
    // rather than a position in a list: only the record that moved is written,
    // and a window may write only the records it owns.
    expect(changed).toHaveLength(1);
    expect(ids(afterMove(three, THIRD, 0))).toStrictEqual([THIRD, FIRST, SECOND]);
  });

  it('moves it into the middle', () => {
    expect(ids(afterMove(three, THIRD, 1))).toStrictEqual([FIRST, THIRD, SECOND]);
  });

  it('moves it to the end', () => {
    expect(ids(afterMove(three, FIRST, 2))).toStrictEqual([SECOND, THIRD, FIRST]);
  });

  it('writes nothing when the tab is already there', () => {
    expect(reorderTerminals({ entries: three, moved: TerminalId.fromString(SECOND), toIndex: 1 }))
      .toStrictEqual([]);
  });

  it('writes nothing for a terminal that is not in the list', () => {
    const stranger = '44444444-4444-4444-8444-444444444444';
    expect(reorderTerminals({ entries: three, moved: TerminalId.fromString(stranger), toIndex: 0 }))
      .toStrictEqual([]);
  });

  it.each([[-3, [THIRD, FIRST, SECOND]], [99, [FIRST, SECOND, THIRD]]])(
    'clamps an index of %p rather than throwing',
    (toIndex, expected) => {
      // The index comes from a page, and a page is the one place a wrong number
      // can arrive from without anybody having made a mistake in this build.
      expect(ids(afterMove(three, THIRD, toIndex))).toStrictEqual(expected);
    }
  );

  it('spreads everything out again when there is no room left between two tabs', () => {
    // Enough drags into the same gap and the midpoints run out. The rule is
    // stated rather than left to floating point: a gap under two milliseconds is
    // no room, and then the whole arrangement is written out evenly. It is the
    // one case where a drag writes more than one record, and it is a case a
    // window can always write, because these are its own records.
    const tight = [tab(FIRST, MINUTE, 1000), tab(SECOND, MINUTE, 1001), tab(THIRD, MINUTE, 1002)];

    const changed = reorderTerminals({
      entries: tight,
      moved: TerminalId.fromString(THIRD),
      toIndex: 1,
    });

    expect(changed.length).toBeGreaterThan(1);
    expect(ids(afterMove(tight, THIRD, 1))).toStrictEqual([FIRST, THIRD, SECOND]);
  });
});
