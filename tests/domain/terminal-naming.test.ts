import { defaultTerminalName } from '../../packages/core/src/index';

/**
 * The default name is the first thing a person sees about a terminal, and the
 * list exists to tell terminals apart. Both properties below are about that one
 * job rather than about strings.
 */
describe('defaultTerminalName names a terminal after its folder', () => {
  it('takes the last segment of a posix path', () => {
    expect(defaultTerminalName('/home/me/projects/auth', [])).toBe('auth');
  });

  it('takes the last segment of a windows path', () => {
    expect(defaultTerminalName('D:\\Projects\\Gripterm', [])).toBe('Gripterm');
  });

  it('reads both separators in one path', () => {
    // A cwd reaches us from the editor and from a settings file, and only one of
    // the two forms is native on any given machine.
    expect(defaultTerminalName('D:/Projects\\Gripterm/source', [])).toBe('source');
  });

  it('ignores a trailing separator', () => {
    expect(defaultTerminalName('/home/me/auth/', [])).toBe('auth');
  });

  it('falls back rather than naming a terminal after a drive', () => {
    // `D:` in the list reads as a mistake, because it is one: there is no folder
    // there to be named after.
    expect(defaultTerminalName('D:\\', [])).toBe('claude');
    expect(defaultTerminalName('C:', [])).toBe('claude');
  });

  it('falls back when there is no path at all', () => {
    expect(defaultTerminalName('', [])).toBe('claude');
    expect(defaultTerminalName('/', [])).toBe('claude');
  });
});

describe('defaultTerminalName gives every terminal a name of its own', () => {
  it('leaves the first one unsuffixed', () => {
    expect(defaultTerminalName('/w/auth', ['other'])).toBe('auth');
  });

  it('counts up past the names already taken', () => {
    // Two terminals in one folder is the normal case -- one writing code, one
    // running tests -- and two identical rows defeat the list.
    expect(defaultTerminalName('/w/auth', ['auth'])).toBe('auth 2');
    expect(defaultTerminalName('/w/auth', ['auth', 'auth 2'])).toBe('auth 3');
  });

  it('reuses a name that has been freed', () => {
    // Counting entries instead of probing names would leave a gap that grows
    // for the life of the window: close `auth`, and the next one becomes
    // `auth 3` with no `auth` in sight.
    expect(defaultTerminalName('/w/auth', ['auth 2'])).toBe('auth');
    expect(defaultTerminalName('/w/auth', ['auth', 'auth 3'])).toBe('auth 2');
  });

  it('does not confuse a name that merely starts the same way', () => {
    expect(defaultTerminalName('/w/auth', ['authentication'])).toBe('auth');
  });
});
