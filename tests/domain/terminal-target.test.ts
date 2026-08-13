import { TerminalId, chooseTerminal, terminalIdFrom } from '../../packages/core/src/index';
import { NEXT_SESSION_UUID, SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

/**
 * Three callers hand over three different things, and the one that is easy to
 * forget is the tree menu: the editor passes the ELEMENT the row was built
 * from, not the id we put on the item. A command that read only strings would
 * be a menu entry that silently does nothing.
 */
describe('terminalIdFrom reads the terminal a command was invoked on', () => {
  it('reads the id a notification button carried', () => {
    expect(terminalIdFrom(TERMINAL_UUID)?.value).toBe(TERMINAL_UUID);
  });

  it('reads the entry a tree menu passed', () => {
    const entry = makeEntry();

    expect(terminalIdFrom(entry)?.value).toBe(entry.terminalId.value);
  });

  it('refuses the command palette, which passes nothing', () => {
    expect(terminalIdFrom(undefined)).toBeNull();
  });

  it('refuses a string that is not an id', () => {
    // Guessing here would be a wrong terminal, and closing is one of the things
    // these commands do.
    expect(terminalIdFrom('auth-refactor')).toBeNull();
    expect(terminalIdFrom('')).toBeNull();
  });

  it('refuses an object that merely looks like an entry', () => {
    // `instanceof`, not a shape check: the tree passes our own instances, and
    // anything else claiming to be one has come from somewhere we do not know.
    expect(terminalIdFrom({ terminalId: { value: TERMINAL_UUID } })).toBeNull();
    expect(terminalIdFrom(null)).toBeNull();
    expect(terminalIdFrom(42)).toBeNull();
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
