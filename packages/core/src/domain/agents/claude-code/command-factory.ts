import { LaunchCommandBuilder } from './launch-command-builder';
import { SessionSettingsBuilder } from './session-settings-builder';
import type { AgentCommand } from '../../entities/agent-command';
import type { AgentCommandFactory } from '../../ports/agent-command-factory';
import type { ForwarderScript, SessionSettingsDocument } from './session-settings-builder';
import type { LaunchIntent } from '../../entities/launch-intent';
import type { ListeningAddress } from '../../entities/listening-address';
import type { TerminalEntry } from '../../entities/terminal-entry';
import type { TerminalId } from '../../entities/terminal-id';

/**
 * Where a terminal's settings file goes, as this factory needs it.
 *
 * Declared here rather than in `domain/ports/`, and that is the agent boundary
 * doing its job rather than an oversight: the document is one CLI's schema, so
 * a port in the neutral domain naming it would make the neutral domain import
 * `agents/` -- which the linter refuses (decision №34). `FileSessionSettingsStore`
 * satisfies this structurally, from `infrastructure/`, where naming one agent is
 * allowed.
 */
export interface SessionSettingsStore {
  write: (terminalId: TerminalId, document: SessionSettingsDocument) => Promise<string>;
}

export interface ClaudeCodeCommandFactoryOptions {
  /** Absolute path to `claude`, resolved once at activation. */
  readonly executablePath: string;
  /** Where this activation's hook receiver is listening. */
  readonly address: ListeningAddress;
  /** This activation's secret, which the hooks present back to that receiver. */
  readonly token: string;
  /** `null` on a machine with no interpreter for the forwarder -- see `SessionSettingsParams`. */
  readonly sessionStart: ForwarderScript | null;
  readonly settings: SessionSettingsStore;
}

/**
 * The launch pipeline, in the order the CLI requires it: write the file, then
 * name it.
 *
 * This is the whole of what M1.14 composes, and the reason `AgentCommandFactory`
 * is asynchronous. `--settings` points at a file the CLI reads in its first
 * milliseconds, and the lifecycle service starts the process the moment this
 * promise resolves -- so the write has to have happened, not been started.
 *
 * The two builders are constructed here rather than injected. Both are pure and
 * stateless, no test has ever wanted a different one, and a constructor
 * parameter for each would be two more ways for the composition root to assemble
 * this wrongly. What IS injected is the store -- the only part that touches a
 * disk, and the only part a caller could reasonably want elsewhere.
 *
 * A fresh file per start, never a cached one: the port inside it belongs to this
 * activation, and a stale port is silent (a failed hook is non-blocking, so the
 * terminal would run perfectly and never be seen again).
 */
export class ClaudeCodeCommandFactory implements AgentCommandFactory {
  private readonly _options: ClaudeCodeCommandFactoryOptions;
  private readonly _settings = new SessionSettingsBuilder();
  private readonly _commands = new LaunchCommandBuilder();

  constructor(options: ClaudeCodeCommandFactoryOptions) {
    this._options = options;
  }

  public async commandFor(entry: TerminalEntry, intent: LaunchIntent): Promise<AgentCommand> {
    const document = this._settings.build({
      terminalId: entry.terminalId,
      address: this._options.address,
      sessionStart: this._options.sessionStart,
    });
    // Deliberately not caught. A settings file that could not be written means a
    // terminal that would run unobserved, and the caller's refusal -- with a
    // sentence for the person who pressed the button -- is the right answer to
    // that, not a launch we cannot see.
    const settingsPath = await this._options.settings.write(entry.terminalId, document);

    return this._commands.build({
      executablePath: this._options.executablePath,
      entry,
      intent,
      settingsPath,
      token: this._options.token,
    });
  }
}
