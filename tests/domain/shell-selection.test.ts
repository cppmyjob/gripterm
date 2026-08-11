import { shellKindFor } from '../../packages/core/src/index';

describe('reading a shell path as a quoting family', () => {
  it.each([
    ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell'],
    ['C:\\WINDOWS\\System32\\cmd.exe', 'cmd'],
    ['/bin/bash', 'posix'],
    ['/usr/bin/zsh', 'posix'],
    ['/usr/local/bin/fish', 'posix'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'posix'],
  ])('reads %s as %s', (path, kind) => {
    expect(shellKindFor(path)).toBe(kind);
  });

  it('does not care about the case a program is spelled in', () => {
    // Windows hands these back in whatever case the profile was written in.
    expect(shellKindFor('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE')).toBe(
      'powershell'
    );
    expect(shellKindFor('C:\\WINDOWS\\SYSTEM32\\CMD.EXE')).toBe('cmd');
  });

  it('takes a bare program name as well as a path', () => {
    expect(shellKindFor('pwsh')).toBe('powershell');
    expect(shellKindFor('bash')).toBe('posix');
  });

  it('falls back to posix when the editor reports no shell at all', () => {
    expect(shellKindFor(undefined)).toBe('posix');
    expect(shellKindFor('')).toBe('posix');
  });

  it('falls back to posix for a shell it does not know', () => {
    // A name we cannot identify on Windows is a bash, a zsh or a fish from Git,
    // WSL or a package manager -- `cmd` and PowerShell are the two whose names
    // are fixed. And a wrong family here is loud: the quoting rules refuse what
    // they cannot carry rather than dropping it.
    expect(shellKindFor('C:\\tools\\nushell\\nu.exe')).toBe('posix');
  });

  it('is not confused by a trailing separator', () => {
    expect(shellKindFor('/bin/')).toBe('posix');
  });
});
