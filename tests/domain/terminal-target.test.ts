import { TerminalId, terminalIdFrom } from '../../packages/core/src/index';
import { TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

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

describe('TerminalId.tryFromString', () => {
  it('parses what fromString parses', () => {
    expect(TerminalId.tryFromString(TERMINAL_UUID.toUpperCase())?.value).toBe(TERMINAL_UUID);
  });

  it('answers null where fromString throws', () => {
    expect(TerminalId.tryFromString('not-an-id')).toBeNull();
  });
});
