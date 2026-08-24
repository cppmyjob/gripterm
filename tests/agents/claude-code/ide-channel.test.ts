import { ideChannelEnv } from '../../../packages/core/src/domain/agents/claude-code/ide-channel';

/**
 * The one environment name in this build that only Claude Code reads.
 *
 * It used to live inside `terminalEnvironment`, which is the rule that composes
 * an environment for a terminal of our own. That rule now takes an opaque
 * `agentEnv` and this function fills it in, so the neutral half can be read
 * without knowing whose CLI is about to start (M4.1a).
 *
 * Measured 2026-08-20, by hand, in a real editor: under the `own` engine the
 * CLI reaches the Claude Code extension WITHOUT the port we cannot give it --
 * it finds the extension by the lock files in `~/.claude/ide/`, because
 * `TERM_PROGRAM` tells it that it is inside an editor. The channel works: the
 * agent was asked which file was open and what was selected in it, and answered
 * both. The price is the editor's own terminal taking the focus every time a
 * prompt is sent, which the owner refused to live with.
 */
describe('the channel to the Claude Code extension, which this engine turns off by default', () => {
  it('goes out as the variable the CLI reads, so nothing has to be guessed about it', () => {
    expect(ideChannelEnv(false)).toStrictEqual({ CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' });
  });

  it('says nothing at all when the person asked for the channel', () => {
    // Not "true": the CLI has four other reasons to connect, and a build that
    // wrote `true` here would be claiming to be the one that decided.
    expect(ideChannelEnv(true)).toStrictEqual({});
  });
});
