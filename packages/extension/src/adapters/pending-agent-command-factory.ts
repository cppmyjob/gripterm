import { LaunchError } from '@gripterm/core';
import type { AgentCommand, AgentCommandFactory } from '@gripterm/core';

/**
 * A REFUSAL, standing in for the launch pipeline until M1.14 composes it.
 *
 * It is here rather than absent because the alternative is worse: a
 * `gripterm.newTerminal` that the manifest offers and nothing registers is a
 * palette entry that does nothing when pressed, with no way for a person to
 * find out why. This says why.
 *
 * What is missing is not this class -- it is three things M1.14 owns and M1.12
 * deliberately did not take: the absolute path to `claude` (resolved once at
 * activation, against the version this build is pinned to), the hook server's
 * `ListeningAddress`, and the per-terminal `settings.json` written under it. A
 * terminal started without them would run perfectly and be invisible to us,
 * which is the one failure mode this extension exists to remove.
 *
 * **Delete this file in M1.14.** The integration test `starting a terminal` in
 * `tests/integration/lifecycle.test.ts` asserts the refusal, so replacing the
 * factory turns that test red rather than leaving the placeholder to be
 * discovered years later. Registered as a live workaround in §8.2.
 */
export class PendingAgentCommandFactory implements AgentCommandFactory {
  public async commandFor(): Promise<AgentCommand> {
    throw new LaunchError(
      'Gripterm cannot start Claude Code yet: the launch pipeline (finding claude, the hook server and the per-terminal settings file) is composed in M1.14.'
    );
  }
}
