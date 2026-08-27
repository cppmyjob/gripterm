import type { Disposable } from '../ports/disposable';
import type { TerminalEngine } from '../entities/terminal-engine';
import type { LaunchMode } from './launch-strategy';
import type { TerminalGateway, TerminalHandle, TerminalSpec } from '../ports/terminal-gateway';
import type { TerminalId } from '../entities/terminal-id';

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

/**
 * The same gateway, which says one sentence again the first time it makes a
 * terminal.
 *
 * **Why a second sentence at all.** O5 asks for a fallback that a person can
 * HEAR, and M3.14 measured that ours could not be heard: in Cursor the engine
 * fell back exactly as promised and the owner never saw a word of it. The cause
 * is the editor's, and it is measured rather than guessed --
 * `workbench.desktop.main.js` carries a `PURGE_TIMEOUT` per severity and
 * `get sticky(){...e&&this._severity===Error...}`, so a warning toast is taken
 * off the screen after a few seconds and only an ERROR with buttons stays.
 * **The numbers moved and this record had not**: it said 15e3 for Info and 18e3
 * for Warning, and VS Code 1.135.0 carries `{Info:1e4, Warning:12e3,
 * Error:15e3}` (re-measured 2026-08-27). The conclusion drawn from them stands;
 * the figures are a fact about one build, so they are not quoted here twice --
 * `ui/closing-offer.ts` carries them beside the one place they are acted on.
 * Ours is said from `activate`, which is the same moment a person is answering
 * the editor's question about trusting the folder. Eighteen seconds later it is
 * in the bell, and the bell is not a place anybody looks.
 *
 * So it is said once more at the one moment the person is certainly watching
 * this window: a terminal has just appeared and it is not the kind the setting
 * promised. Nothing else about the port changes -- `engine` above all, because
 * the record is stamped from it and a wrapper answering for itself would be a
 * record that lies about which engine made the terminal.
 *
 * **The price**, so that it is not discovered later: if the first terminal of
 * the window is one a RESTORE made during startup, the reminder is spent there,
 * in the same crowded second as the first sentence. **Removed when** a gateway
 * can be told who asked for a terminal; `TerminalSpec` carries no intent today,
 * and inventing one for the sake of a notification would be the wrong way round.
 */
class RemindingGateway implements TerminalGateway, Disposable {
  private _reminded = false;

  constructor(
    private readonly _gateway: TerminalGateway & Disposable,
    private readonly _say: (message: string) => void,
    private readonly _message: string
  ) {}

  public get engine(): TerminalEngine {
    return this._gateway.engine;
  }

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const handle = await this._gateway.create(spec);
    // After, and only after: the sentence is about a terminal that is now on the
    // screen. A create that threw leaves the person with a failure to read, and
    // a second notification underneath it would bury the one that matters.
    if (!this._reminded) {
      this._reminded = true;
      this._say(this._message);
    }
    return handle;
  }

  public listKnown(): readonly TerminalHandle[] {
    return this._gateway.listKnown();
  }

  public handleFor(terminalId: TerminalId): TerminalHandle | undefined {
    return this._gateway.handleFor(terminalId);
  }

  public dispose(): void {
    this._gateway.dispose();
  }
}

/** See `RemindingGateway`. A function, because the call site reads as one line of composition. */
export function remindOnFirstTerminal(
  gateway: TerminalGateway & Disposable,
  say: (message: string) => void,
  message: string
): TerminalGateway & Disposable {
  return new RemindingGateway(gateway, say, message);
}
