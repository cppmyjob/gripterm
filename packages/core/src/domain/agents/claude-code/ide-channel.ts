/**
 * `CLAUDE_CODE_AUTO_CONNECT_IDE`, and only when the channel is turned OFF.
 *
 * It lives here rather than in `terminalEnvironment` because the variable is
 * one CLI's word: a rule that composed an environment for "the agent" and then
 * wrote a name only Claude Code reads would be claiming to be neutral while
 * hard-coding a product. The composed rule now takes `agentEnv` and does not
 * look inside it; this function is what fills it in for Claude Code.
 *
 * **The channel exists under the `own` engine, which was believed otherwise
 * until 2026-08-20.** The plan said the agent loses the Claude Code extension
 * there, because the extension hands its port to the editor's own terminals
 * through a collection no other extension can read. The port turns out not to
 * be needed: the CLI finds the extension by the lock files in `~/.claude/ide/`,
 * and it goes looking because `TERM_PROGRAM` -- which the composed rule sets on
 * purpose -- tells it that it is inside an editor. Measured by hand in a real
 * window: `/ide` answered "Visual Studio Code ✓", and the agent, asked which
 * file was open and what was selected, named both.
 *
 * **The price, measured the same day.** The editor's own terminal takes the
 * focus away from our panel every time a prompt is sent, and only ONE agent
 * gets the channel at all -- the CLI says so itself: "Only one Claude Code
 * instance can be connected to VS Code at a time". So a panel of five agents
 * pays with its focus for a channel one of them has. The owner's decision of
 * 2026-08-20: off by default, and a setting that turns it back on for whoever
 * wants the other side of the trade.
 *
 * **Why `false` and never `true`.** This is the one answer the CLI takes as
 * final (`CLAUDE_CODE_AUTO_CONNECT_IDE === false` returns before every other
 * check). It has four other reasons to connect, and a build that wrote `true`
 * here would be claiming a decision it did not make; leaving the name unset
 * leaves those four exactly as they were.
 *
 * The person's own delta is applied after this and wins, which is the same
 * order everything else in the composed rule follows.
 */
export function ideChannelEnv(wanted: boolean): Record<string, string> {
  return wanted ? {} : { CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' };
}
