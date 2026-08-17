import {
  LAUNCH_MODES,
  TERMINAL_ENGINES,
  chooseEngine,
  isTerminalEngine,
} from '../../packages/core/src/index';
import type { LaunchMode, TerminalEngine } from '../../packages/core/src/index';

/**
 * Which engine actually runs, out of the one that was asked for.
 *
 * There is exactly one pair that cannot be honoured, and it is a fact about what
 * the two settings mean rather than a limitation of any adapter.
 * `gripterm.launch.mode: shell` starts the person's own shell and TYPES the
 * launch line into it, and the line must not overtake whatever the environment
 * does to a fresh shell (measured 2026-08-14, M2.25: another extension types
 * into a terminal 20-60 ms after it is made, and our line sent on creation lands
 * first). Knowing when a shell has gone quiet is the editor's shell integration.
 * A pty of ours has none, so `own` + `shell` would type the launch line into
 * whatever the shell was doing -- or into nothing.
 *
 * It refuses ALOUD and falls back, which is O5: the `editor` engine stays whole
 * and stays the way back. A refusal that only reached the log would leave a
 * person with a setting that reads `own` and a terminal that is not.
 *
 * The table below is total over both settings -- two engines by two modes -- so
 * a third mode or a third engine fails the compile of this suite rather than
 * silently taking the branch nobody chose.
 */

const CASES: readonly {
  readonly setting: TerminalEngine;
  readonly mode: LaunchMode;
  readonly engine: TerminalEngine;
  readonly refused: boolean;
}[] = [
  { setting: 'editor', mode: 'process', engine: 'editor', refused: false },
  { setting: 'editor', mode: 'shell', engine: 'editor', refused: false },
  { setting: 'own', mode: 'process', engine: 'own', refused: false },
  { setting: 'own', mode: 'shell', engine: 'editor', refused: true },
];

describe('chooseEngine answers for every pair of settings', () => {
  it.each(CASES)(
    'engine $setting with mode $mode runs $engine',
    ({ setting, mode, engine, refused }) => {
      const choice = chooseEngine(setting, mode);

      expect(choice.engine).toBe(engine);
      expect(choice.refusal === null).toBe(!refused);
    }
  );

  it('covers every engine and every mode', () => {
    // The guard on the table above: a fifth pair arriving with no row would
    // otherwise be a case this suite says nothing about.
    for (const setting of TERMINAL_ENGINES) {
      for (const mode of LAUNCH_MODES) {
        expect(CASES.some((row) => row.setting === setting && row.mode === mode)).toBe(true);
      }
    }
    expect(CASES).toHaveLength(TERMINAL_ENGINES.length * LAUNCH_MODES.length);
  });
});

describe('the one refusal says what it refused and what it did instead', () => {
  it('names both settings, so the sentence tells a person what to change', () => {
    // Asserted as content and not as a golden string: this sentence reaches a
    // person through a notification, and a message naming neither setting would
    // leave them looking for a switch they cannot find.
    const { refusal } = chooseEngine('own', 'shell');

    expect(refusal).toContain('gripterm.terminal.engine');
    expect(refusal).toContain('gripterm.launch.mode');
  });

  it('says which engine is running now', () => {
    expect(chooseEngine('own', 'shell').refusal).toContain('editor');
  });
});

describe('the engine names survive the settings file', () => {
  it('is exactly two, and the way back is one of them', () => {
    expect(TERMINAL_ENGINES).toStrictEqual(['editor', 'own']);
  });

  it.each([...TERMINAL_ENGINES])('reads %s back', (engine) => {
    expect(isTerminalEngine(engine)).toBe(true);
  });

  it.each(['own-pty', 'Own', '', 'editor '])('refuses %p', (value) => {
    expect(isTerminalEngine(value)).toBe(false);
  });
});
