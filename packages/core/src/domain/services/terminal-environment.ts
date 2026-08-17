/**
 * The environment a terminal of OUR OWN gives the agent.
 *
 * The editor's engine needs none of this: `TerminalOptions.env` is a delta the
 * platform applies to whatever it gives its own terminals, and `null` in it
 * already means "unset this". A pty has no such notion -- `node-pty` REPLACES the
 * environment and has no way to say "remove" -- so the delta has to be applied
 * here, and applied in an order that is chosen rather than incidental:
 *
 *   the host's own environment
 *     minus the nine names the editor keeps for itself
 *     plus the three the editor gives its terminals and we can
 *     plus the delta, in which `null` REMOVES
 *
 * The delta goes last because it is the only part of the four somebody chose. Our
 * own `LaunchCommandBuilder` puts nine `null`s in it -- the markers of the Claude
 * Code session that started the editor -- and a person's `extraEnv` arrives in
 * the same place. `{...process.env, ...spec.env}` would satisfy neither: it would
 * hand the CLI `CLAUDE_CODE_CHILD_SESSION="null"`, and with that variable present
 * in ANY form the CLI writes no transcript and no history line at all (A28,
 * measured 2026-08-13). Nothing says so; the conversation simply cannot be
 * resumed afterwards, by us or by anybody.
 *
 * Measured 2026-08-17, M3.2 stage B §5.1, on a clean baseline instance of
 * VS Code -- `process.env` of the extension host against the environment of a
 * terminal that editor opened.
 *
 * **What this cannot give the agent, said here rather than discovered.** Ten
 * names the editor's terminals have and a pty of ours would not. Three are
 * below. The other seven are set by OTHER extensions through
 * `environmentVariableCollection`, and the stable API exposes only our own
 * (`@types/vscode` 1.94, `index.d.ts:8084`) -- there is no read of another
 * extension's collection to be had. So under `own` the agent gets no
 * `CLAUDE_CODE_SSE_PORT` (the Claude Code extension's own channel to the CLI) and
 * no `GIT_ASKPASS` / `VSCODE_GIT_*` (the editor's credential prompt). Both are
 * losses of the engine, not omissions of this rule, and both are named in the
 * plan's register (§7.2) with a measurement of their own to come before `own`
 * could ever become the default.
 */

/**
 * The nine the editor keeps for itself: present in the extension host's own
 * environment and in none of the terminals it opens.
 *
 * `ELECTRON_RUN_AS_NODE` alone is enough to matter -- with it set, a `code .`
 * typed inside the agent runs the editor's binary as a bare Node and does
 * nothing at all -- and `VSCODE_IPC_HOOK` names this window's socket, which is
 * not the agent's business to hold.
 */
export const EDITOR_INTERNAL_NAMES: readonly string[] = Object.freeze([
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

/** What the editor calls itself to a program running inside one of its terminals. */
export interface EditorIdentity {
  /** `TERM_PROGRAM`. The CLI reads it to know it is inside an editor. */
  readonly termProgram: string;
  /** `TERM_PROGRAM_VERSION`. */
  readonly termProgramVersion: string;
}

export interface TerminalEnvironmentParams {
  /** The extension host's own environment, `process.env` shaped: a lost name is `undefined`. */
  readonly host: Readonly<Record<string, string | undefined>>;
  /** What the launch asked for. `null` removes a name the host would otherwise pass on. */
  readonly delta: Readonly<Record<string, string | null>>;
  readonly editor: EditorIdentity;
  /**
   * Whether the platform tells `Path` and `PATH` apart. Windows does not; Unix
   * does.
   *
   * An input rather than a check of `process.platform`, because this rule is in
   * the core and the platform is not. It is not cosmetic: the measurement stand
   * of M3.2 died on "An item with the same key has already been added" over two
   * names differing only in case (§9.6), and a pty handed both `Path` and `PATH`
   * gets whichever of them the platform decides to keep.
   */
  readonly caseInsensitiveNames: boolean;
}

/**
 * `COLORTERM`, which is a statement about the SCREEN rather than about the
 * editor: what we are about to draw the bytes on is xterm.js, and it renders
 * 24-bit colour. The editor sets this variable for its own terminals for the
 * same reason.
 */
const TRUE_COLOUR = 'truecolor';

export function terminalEnvironment(params: TerminalEnvironmentParams): Record<string, string> {
  const table = new NameTable(params.caseInsensitiveNames);

  for (const [name, value] of Object.entries(params.host)) {
    if (value !== undefined) {
      table.set(name, value);
    }
  }
  for (const name of EDITOR_INTERNAL_NAMES) {
    table.remove(name);
  }
  for (const [name, value] of Object.entries(identityOf(params.editor))) {
    table.set(name, value);
  }
  for (const [name, value] of Object.entries(params.delta)) {
    if (value === null) {
      table.remove(name);
    } else {
      table.set(name, value);
    }
  }

  return table.toObject();
}

/**
 * The three of the editor's ten we can produce ourselves.
 *
 * A blank one is not written: `TERM_PROGRAM=""` tells the CLI it is running
 * inside a program called nothing, which is a worse answer than not answering.
 *
 * `TERM` is deliberately absent FROM THIS RULE, which is not the same as absent
 * from the process (found 2026-08-17, M3.4-B): node-pty writes it into every
 * child regardless -- `env.TERM = opt.name || env.TERM || 'xterm'` in both its
 * terminals -- so the adapter names the value there, where the fact about the
 * library is. What this rule would be doing by naming one is claiming to know
 * what an editor sets, and it is not in the measured delta on win32. Where the
 * platform does set it, it is in the host environment and passes through here
 * untouched.
 */
function identityOf(editor: EditorIdentity): Record<string, string> {
  return {
    COLORTERM: TRUE_COLOUR,
    ...named('TERM_PROGRAM', editor.termProgram),
    ...named('TERM_PROGRAM_VERSION', editor.termProgramVersion),
  };
}

/**
 * A name with its value, or nothing at all.
 *
 * A conditional expression and not an `if`, for a reason that is a measurement
 * rather than a taste: Istanbul reports an `if` WITH NO `else` as a single branch
 * path, so a 100% branch threshold over this file cannot tell an unexercised
 * blank case from an exercised one. Written this way, the empty half is a path of
 * its own and the threshold has something to hold. (Measured 2026-08-17 by
 * reading `coverage-final.json`: the `if` form reported `paths 1`.)
 */
function named(name: string, value: string): Record<string, string> {
  return value.trim().length > 0 ? { [name]: value } : {};
}

/**
 * Environment names, compared the way the platform compares them.
 *
 * A name that is already there keeps the CASING IT ARRIVED WITH and takes the new
 * value, rather than being joined by a second spelling of itself. That is what
 * the editor does, and it is the only shape in which "one name, one value" is
 * true of the block a pty is handed.
 */
class NameTable {
  private readonly _folded: boolean;
  private readonly _entries = new Map<string, { name: string, value: string }>();

  constructor(folded: boolean) {
    this._folded = folded;
  }

  public set(name: string, value: string): void {
    const key = this._key(name);
    const existing = this._entries.get(key);
    this._entries.set(key, { name: existing?.name ?? name, value });
  }

  public remove(name: string): void {
    this._entries.delete(this._key(name));
  }

  public toObject(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const { name, value } of this._entries.values()) {
      result[name] = value;
    }
    return result;
  }

  private _key(name: string): string {
    return this._folded ? name.toUpperCase() : name;
  }
}
