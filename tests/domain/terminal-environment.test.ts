import {
  EDITOR_INTERNAL_NAMES,
  terminalEnvironment,
  type TerminalEnvironmentParams,
} from '../../packages/core/src/index';

/**
 * The environment an `own` terminal gets, which is a DELTA and not a copy.
 *
 * Every row here is a measurement or a decision from M3.2 stage B (§5.1,
 * 2026-08-17), taken on a clean baseline instance of VS Code:
 *
 *  * **Nine names the editor keeps for itself.** They are in the extension
 *    host's own `process.env` and in no terminal the editor opens. A pty of ours
 *    that copies `process.env` hands them to the agent, and `ELECTRON_RUN_AS_NODE`
 *    alone is enough to make `code .` inside that agent do nothing at all.
 *  * **`null` in the delta means REMOVE**, because that is what the delta already
 *    means everywhere else in this build: `LaunchCommandBuilder` puts nine nulls
 *    in it, one of them `CLAUDE_CODE_CHILD_SESSION`, and an agent that inherits
 *    that variable writes NO transcript and NO history line (A28). A pty that
 *    read `null` as a value would hand the CLI the string "null" and П7 would die
 *    without a sound.
 *  * **Three names we add.** `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`
 *    are three of the ten the editor gives its own terminals and we would not.
 *    The other seven cannot be had: six are set by OTHER extensions through
 *    `environmentVariableCollection`, and the stable API exposes only our own
 *    (`@types/vscode` 1.94, `index.d.ts:8084`). That is a named loss of the `own`
 *    engine, not an omission here.
 *  * **`TERM` is deliberately absent.** It is not in the measured delta on
 *    win32 -- the editor does not set it there either -- and the live `claude`
 *    of M3.2(4) came up under ConPTY with none. Adding it would be this suite
 *    asserting an unmeasured claim about another platform.
 *
 * Case folding is an input rather than a platform check, because the rule is in
 * the core and the platform is not. Windows compares environment names without
 * regard to case; Unix does not. Getting it wrong is not a cosmetic matter: the
 * measurement stand itself died on `An item with the same key has already been
 * added` when two names differed only in case (§9.6), and a pty handed both
 * `Path` and `PATH` gets whichever the platform picks.
 */

const EDITOR = { termProgram: 'vscode', termProgramVersion: '1.133.0' } as const;

function environment(overrides: Partial<TerminalEnvironmentParams> = {}): Record<string, string> {
  return terminalEnvironment({
    host: { PATH: '/usr/bin', HOME: '/home/x' },
    delta: {},
    editor: EDITOR,
    caseInsensitiveNames: false,
    ...overrides,
  });
}

describe('the environment starts from the host and loses what belongs to the editor', () => {
  it('carries the host environment through', () => {
    expect(environment()).toStrictEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.133.0',
    });
  });

  it('drops a host name the platform reports with no value', () => {
    // `process.env` is typed `string | undefined` and means it: a name read from
    // a lost variable would otherwise arrive at the pty as the string
    // "undefined".
    const result = environment({ host: { PATH: '/usr/bin', EMPTIED: undefined } });

    expect(result.PATH).toBe('/usr/bin');
    expect('EMPTIED' in result).toBe(false);
  });

  it('names the nine the editor keeps for itself, and no others', () => {
    // Written out rather than compared against the source list: this row IS the
    // measurement, and a generated expectation would be the implementation a
    // second time.
    expect([...EDITOR_INTERNAL_NAMES].sort()).toStrictEqual([
      'ELECTRON_RUN_AS_NODE',
      'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
      'VSCODE_CWD',
      'VSCODE_ESM_ENTRYPOINT',
      'VSCODE_HANDLES_UNCAUGHT_ERRORS',
      'VSCODE_IPC_HOOK',
      'VSCODE_L10N_BUNDLE_LOCATION',
      'VSCODE_NLS_CONFIG',
      'VSCODE_PID',
    ]);
  });

  it.each([...EDITOR_INTERNAL_NAMES])('removes %s, however it arrived', (name) => {
    const result = environment({ host: { PATH: '/usr/bin', [name]: 'from the host' } });

    expect(name in result).toBe(false);
  });

  it('lets the delta put one of them back, because somebody asked for it by name', () => {
    // The order is the whole statement: the host is cleaned first, the delta is
    // applied last. A name in the delta was chosen -- by us or by a person's
    // `extraEnv` -- and this rule does not overrule a choice.
    const result = environment({
      host: { VSCODE_PID: 'inherited' },
      delta: { VSCODE_PID: 'asked for' },
    });

    expect(result.VSCODE_PID).toBe('asked for');
  });
});

describe('the environment adds the three the editor gives and we can', () => {
  it('says what the terminal can draw and which program it is inside', () => {
    const result = environment({ editor: { termProgram: 'cursor', termProgramVersion: '3.13.0' } });

    expect(result.COLORTERM).toBe('truecolor');
    expect(result.TERM_PROGRAM).toBe('cursor');
    expect(result.TERM_PROGRAM_VERSION).toBe('3.13.0');
  });

  it('does not add TERM, which was not in the measured delta', () => {
    expect('TERM' in environment()).toBe(false);
  });

  it('carries the host TERM when the host has one', () => {
    // Not adding it is not the same as removing it: on a platform that sets it,
    // the value is already in the host environment and belongs to the terminal.
    expect(environment({ host: { TERM: 'xterm-256color' } }).TERM).toBe('xterm-256color');
  });

  it.each([
    ['program', { termProgram: '', termProgramVersion: '1.133.0' }, 'TERM_PROGRAM'],
    ['version', { termProgram: 'vscode', termProgramVersion: '' }, 'TERM_PROGRAM_VERSION'],
  ])('writes no blank %s', (_what, editor, name) => {
    // A blank `TERM_PROGRAM` tells the CLI it is running inside a program called
    // "", which is a worse answer than not answering.
    expect(name in environment({ editor })).toBe(false);
  });

  it('lets a person override what we say about their terminal', () => {
    const result = environment({ delta: { COLORTERM: '256color' } });

    expect(result.COLORTERM).toBe('256color');
  });

  it('lets the delta remove what we add', () => {
    const result = environment({ delta: { COLORTERM: null } });

    expect('COLORTERM' in result).toBe(false);
  });
});

describe('the delta sets and removes', () => {
  it('adds a name the host did not have', () => {
    expect(environment({ delta: { GRIPTERM_TOKEN: 'abc' } }).GRIPTERM_TOKEN).toBe('abc');
  });

  it('replaces a name the host had', () => {
    expect(environment({ delta: { PATH: '/opt/bin' } }).PATH).toBe('/opt/bin');
  });

  it('removes a name the host had', () => {
    const result = environment({ delta: { HOME: null } });

    expect('HOME' in result).toBe(false);
    expect(result.PATH).toBe('/usr/bin');
  });

  it('removing a name that is not there is not an error and does not add it', () => {
    const result = environment({ delta: { CLAUDE_CODE_CHILD_SESSION: null } });

    expect('CLAUDE_CODE_CHILD_SESSION' in result).toBe(false);
  });

  it('never carries a null through as a value', () => {
    // The failure this whole shape exists to prevent: `{...process.env,
    // ...spec.env}` would hand the pty `CLAUDE_CODE_CHILD_SESSION="null"`, and
    // with that variable set the CLI writes neither transcript nor history line
    // (A28) -- silently.
    const result = environment({
      host: { CLAUDE_CODE_CHILD_SESSION: 'another run' },
      delta: { CLAUDE_CODE_CHILD_SESSION: null },
    });

    expect(Object.values(result)).not.toContain('null');
    expect('CLAUDE_CODE_CHILD_SESSION' in result).toBe(false);
  });
});

describe('the environment folds case where the platform does', () => {
  it('replaces the host name in the casing the host used', () => {
    // One key, not two. `Path` is what Windows itself puts in `process.env`, and
    // a block carrying both `Path` and `PATH` leaves the choice to the platform.
    const result = terminalEnvironment({
      host: { Path: 'C:/Windows' },
      delta: { PATH: 'C:/tools' },
      editor: EDITOR,
      caseInsensitiveNames: true,
    });

    expect(result.Path).toBe('C:/tools');
    expect('PATH' in result).toBe(false);
  });

  it('removes a host name whose casing differs from the delta', () => {
    const result = terminalEnvironment({
      host: { Path: 'C:/Windows' },
      delta: { PATH: null },
      editor: EDITOR,
      caseInsensitiveNames: true,
    });

    expect('Path' in result).toBe(false);
    expect('PATH' in result).toBe(false);
  });

  it('removes an editor name whose casing differs', () => {
    const result = terminalEnvironment({
      host: { vscode_pid: '4242' },
      delta: {},
      editor: EDITOR,
      caseInsensitiveNames: true,
    });

    expect('vscode_pid' in result).toBe(false);
  });

  it('keeps two names that differ only in case where the platform tells them apart', () => {
    const result = terminalEnvironment({
      host: { Path: '/a' },
      delta: { PATH: '/b' },
      editor: EDITOR,
      caseInsensitiveNames: false,
    });

    expect(result.Path).toBe('/a');
    expect(result.PATH).toBe('/b');
  });

  it('keeps an editor name in the wrong case where the platform tells them apart', () => {
    const result = terminalEnvironment({
      host: { vscode_pid: '4242' },
      delta: {},
      editor: EDITOR,
      caseInsensitiveNames: false,
    });

    expect(result.vscode_pid).toBe('4242');
  });
});
