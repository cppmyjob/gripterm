import { TerminalId, chooseTerminal, showingFirst, terminalTargetOf } from '../../packages/core/src/index';
import { NEXT_SESSION_UUID, SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

/**
 * Three callers hand over three different things, and the one that is easy to
 * forget is the tree menu: the editor passes the ELEMENT the row was built
 * from, not the id we put on the item. A command that read only strings would
 * be a menu entry that silently does nothing.
 */
describe('terminalTargetOf reads the terminal a command was invoked on', () => {
  it('reads the id a notification button carried', () => {
    expect(terminalTargetOf(TERMINAL_UUID)).toEqual({
      kind: 'terminal',
      terminalId: TerminalId.fromString(TERMINAL_UUID),
    });
  });

  it('reads the entry a tree row is', () => {
    const entry = makeEntry();

    expect(terminalTargetOf(entry)).toEqual({ kind: 'terminal', terminalId: entry.terminalId });
  });

  it('says nothing was passed when the command came from the palette', () => {
    expect(terminalTargetOf(undefined)).toEqual({ kind: 'none' });
  });

  it('refuses a string that is not an id', () => {
    // Guessing here would be a wrong terminal, and closing is one of the things
    // these commands do.
    expect(terminalTargetOf('auth-refactor')).toEqual({ kind: 'unreadable' });
    expect(terminalTargetOf('')).toEqual({ kind: 'unreadable' });
  });

  it('refuses an object that merely looks like an entry', () => {
    // `instanceof`, not a shape check: the tree passes our own instances, and
    // anything else claiming to be one has come from somewhere we do not know.
    expect(terminalTargetOf({ terminalId: { value: TERMINAL_UUID } })).toEqual({
      kind: 'unreadable',
    });
    expect(terminalTargetOf(null)).toEqual({ kind: 'unreadable' });
    expect(terminalTargetOf(42)).toEqual({ kind: 'unreadable' });
  });

  /**
   * The defect this answer was split for (M2.21, reported by the owner).
   *
   * A row's `Delete Record` opened the picker -- "delete the record of which
   * terminal?" -- because the tree had started handing back a wrapper around the
   * entry and the resolver read it as nothing at all. Both ways of having no id
   * answered the same, so the command could not tell "nobody said which" from "I
   * was told and could not read it", and quietly asked. One Enter on the first
   * row of that picker is another terminal's record in the trash.
   */
  it('tells nothing-was-passed from that-was-not-a-terminal', () => {
    const wrapped = { kind: 'terminal', entry: makeEntry() };

    expect(terminalTargetOf(wrapped).kind).toBe('unreadable');
    expect(terminalTargetOf(undefined).kind).toBe('none');
  });
});

/**
 * The defect behind this block was reported by the owner and is worth writing
 * down, because nothing in the build was broken: `Gripterm: Rename Terminal`
 * from the palette opened the terminal PICKER first, a picker is an empty box
 * with a list under it, and an empty box is a thing people type into. The name
 * went in as a filter, matched no row, and Enter on no row does nothing at all.
 */
describe('chooseTerminal decides whether a command has to ask which one', () => {
  const one = TerminalId.fromString(TERMINAL_UUID);
  const another = TerminalId.fromString(SESSION_UUID);
  const third = TerminalId.fromString(NEXT_SESSION_UUID);

  it('says there is nothing to act on when the window holds none', () => {
    expect(chooseTerminal([], 'take')).toEqual({ kind: 'nothing' });
    expect(chooseTerminal([], 'ask')).toEqual({ kind: 'nothing' });
  });

  it('takes the only one when the command allows it', () => {
    expect(chooseTerminal([one], 'take')).toEqual({ kind: 'take', terminalId: one });
  });

  it('still asks about the only one when the command says to ask', () => {
    // Closing is the case: the picker is the last place a person sees what
    // they are about to end.
    expect(chooseTerminal([one], 'ask')).toEqual({ kind: 'ask' });
  });

  it('asks whenever there is more than one, whatever the command allows', () => {
    // The half that matters: "take the only one" must never become "take the
    // first one", which would act on a terminal nobody chose.
    expect(chooseTerminal([one, another], 'take')).toEqual({ kind: 'ask' });
    expect(chooseTerminal([one, another], 'ask')).toEqual({ kind: 'ask' });
    expect(chooseTerminal([one, another, third], 'take')).toEqual({ kind: 'ask' });
  });
});

describe('TerminalId.tryFromString', () => {
  it('parses what fromString parses', () => {
    expect(TerminalId.tryFromString(TERMINAL_UUID.toUpperCase())?.value).toBe(TERMINAL_UUID);
  });

  it('answers null where fromString throws', () => {
    expect(TerminalId.tryFromString('not-an-id')).toBeNull();
  });
});

/**
 * The order a picker offers its rows in, and the owner's decision behind it
 * (2026-08-20).
 *
 * `Gripterm: Add Note` opens a picker and then a box, and the pair reads as ONE
 * dialog to the person who did not build it -- met twice, in M3.10 and in the
 * M3.14 acceptance. The fix the owner chose is deliberately NOT "act on the
 * terminal that is on screen": that would be `chooseTerminal`'s warning come
 * true, a command acting on a record nobody picked. It is the gentler half --
 * the row they are already looking at comes first, wearing a mark, so the
 * answer is one Enter and it is still an answer they gave.
 */

const FIRST = TerminalId.fromString(TERMINAL_UUID);
const SECOND = TerminalId.fromString(SESSION_UUID);
const THIRD = TerminalId.fromString(NEXT_SESSION_UUID);
const rows = [{ terminalId: FIRST }, { terminalId: SECOND }, { terminalId: THIRD }];

describe('showingFirst puts the row the person is looking at at the top', () => {
  it('moves it up and leaves the others in the order they were in', () => {
    expect(showingFirst(rows, THIRD)).toStrictEqual([
      { terminalId: THIRD },
      { terminalId: FIRST },
      { terminalId: SECOND },
    ]);
  });

  it('changes nothing when this window is showing no terminal at all', () => {
    // The editor's engine, and every window before the panel is opened: there is
    // no screen of ours, so there is nothing anybody is looking at.
    expect(showingFirst(rows, null)).toStrictEqual(rows);
  });

  it('changes nothing when the terminal on screen is not one of the candidates', () => {
    // The ordinary case for a picker of somebody else's rows -- adoption offers
    // records this window does not own, and the terminal on our screen is ours.
    expect(showingFirst([{ terminalId: FIRST }, { terminalId: SECOND }], THIRD)).toStrictEqual([
      { terminalId: FIRST },
      { terminalId: SECOND },
    ]);
  });

  it('offers exactly the same rows, never one more and never one fewer', () => {
    // The guard that matters: a reordering that dropped or doubled a row would
    // be a terminal a person cannot reach, or two that look alike.
    const ordered = showingFirst(rows, SECOND);

    const values = (list: readonly { readonly terminalId: TerminalId }[]): string[] =>
      list.map((one) => one.terminalId.value).sort();

    expect(ordered).toHaveLength(rows.length);
    expect(values(ordered)).toStrictEqual(values(rows));
  });
});
