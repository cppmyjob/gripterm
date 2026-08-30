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
 * both. The price the owner refused to live with was the editor's own terminal
 * taking the focus every time a prompt was sent -- and that price is the half of
 * this that did not survive the next measurement, below.
 *
 * **What 2026-08-30 changed about that, and why the name of this suite no
 * longer says the engine turns the channel off.** On CLI 2.1.245 the channel
 * does not come up unasked at all -- eight windows, both editors, both values of
 * the setting -- and the variable below does not close it either: a `/ide` typed
 * by hand connected with it set, and the agent named the open file and the
 * selected line. Nor was the FOCUS price found: an instrument watching 163
 * samples after a prompt was sent saw nothing move in Cursor, where its positive
 * control moved everything, and sending in VS Code was not watched at all. So the two cases below hold exactly what they say and nothing
 * wider: which name goes out, and when. What that name then buys, and what the
 * measurement does not cover, is written where the name is composed.
 */
describe('the one name this build sets about the channel to the Claude Code extension', () => {
  it('goes out as the variable the CLI reads, so nothing has to be guessed about it', () => {
    expect(ideChannelEnv(false)).toStrictEqual({ CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' });
  });

  it('says nothing at all when the person allowed the unasked connection', () => {
    // Not "true": the CLI has four other reasons to connect unasked, none of
    // them seen firing on 2.1.245, and a build that wrote `true` here would be
    // claiming to be the one that decided.
    expect(ideChannelEnv(true)).toStrictEqual({});
  });
});
