import { LaunchError } from '@gripterm/core';
import type { AgentCommand, AgentCommandFactory } from '@gripterm/core';

/**
 * What stands in for the launch pipeline when this machine cannot supply it.
 *
 * NOT the placeholder it replaced. `PendingAgentCommandFactory` (workaround C4,
 * removed in M1.14) stood for code that had not been written; this stands for a
 * state of the world -- Claude Code is not installed, or no loopback port could
 * be taken -- and it is permanent. The reason arrives already written by
 * `launchReadiness`, in core, where it is tested; nothing here decides anything.
 *
 * It refuses rather than launching blind on purpose (see `launchReadiness`), and
 * it refuses with a `LaunchError` so that the command that called it shows the
 * sentence to the person instead of "see the log".
 */
export class UnavailableAgentCommandFactory implements AgentCommandFactory {
  constructor(private readonly _reason: string) {}

  public async commandFor(): Promise<AgentCommand> {
    throw new LaunchError(this._reason);
  }
}
