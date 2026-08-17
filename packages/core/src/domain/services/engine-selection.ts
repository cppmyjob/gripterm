import type { TerminalEngine } from '../entities/terminal-engine';
import type { LaunchMode } from './launch-strategy';

/**
 * Which engine runs, out of the one the settings asked for.
 *
 * There is exactly one pair of settings that cannot be honoured, and it is a
 * fact about what they MEAN rather than a limitation of any adapter.
 * `gripterm.launch.mode: shell` starts the person's own shell and types the
 * launch line into it, and that line must not overtake whatever the environment
 * does to a fresh shell -- measured 2026-08-14 (M2.25): another extension types
 * into a terminal 20-60 ms after it is created, and a line of ours sent on
 * creation lands FIRST, so the environment's command ends up typed into the
 * agent's prompt. Knowing when a shell has gone quiet is the editor's shell
 * integration. A pty of ours has none.
 *
 * So `own` + `shell` falls back to `editor`, and it says so out loud rather than
 * only in the log (O5): a person left with a setting that reads `own` and a
 * terminal that is not would have no way to find out.
 *
 * This is not the only way the `editor` engine gets chosen -- the native addon
 * failing to load is the other, and it is the adapter's business -- but the
 * record never learns the engine from here. It learns it from the gateway that
 * actually made the terminal, so the two paths cannot disagree.
 */
export interface EngineChoice {
  readonly engine: TerminalEngine;
  /** What to tell the person when the engine they asked for could not be used, or `null`. */
  readonly refusal: string | null;
}

/**
 * Names both settings, because it reaches a person as a notification: a sentence
 * that named neither would leave them looking for a switch they cannot find.
 */
const SHELL_REFUSAL =
  'gripterm.terminal.engine: own cannot run gripterm.launch.mode: shell -- typing the launch line ' +
  'into your own shell needs the editor to say when that shell is listening, and a terminal of our ' +
  'own has nobody to ask. Running on the editor engine instead.';

export function chooseEngine(setting: TerminalEngine, mode: LaunchMode): EngineChoice {
  if (setting === 'own' && mode === 'shell') {
    return { engine: 'editor', refusal: SHELL_REFUSAL };
  }
  return { engine: setting, refusal: null };
}
