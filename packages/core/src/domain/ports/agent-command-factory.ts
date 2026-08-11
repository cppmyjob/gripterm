import type { AgentCommand } from '../entities/agent-command';
import type { LaunchIntent } from '../entities/launch-intent';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * Where an argument vector comes from, as seen by the lifecycle service.
 *
 * The service starts terminals; it must not know whose CLI is in them. That is
 * the boundary of decision №34, and this port is where it is crossed: the flag
 * list lives under `domain/agents/<name>/`, the composition root picks one, and
 * everything in between sees an `AgentCommand` and nothing else.
 *
 * It returns a promise because building the command is not pure. Claude Code's
 * `--settings` points at a file that has to exist by the time the process
 * starts, and that file is per-terminal and regenerated on every launch (§4.7).
 * A synchronous signature would push that write somewhere the launch does not
 * wait for it, which is a race with the terminal's first millisecond.
 *
 * `intent` is a parameter and not something read off the entry, for the reason
 * `LaunchIntent` exists: the CLI refuses `--session-id` together with `--resume`
 * and nothing in the record distinguishes the two paths.
 */
export interface AgentCommandFactory {
  commandFor: (entry: TerminalEntry, intent: LaunchIntent) => Promise<AgentCommand>;
}
