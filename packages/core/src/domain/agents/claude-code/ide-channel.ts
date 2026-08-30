/**
 * `CLAUDE_CODE_AUTO_CONNECT_IDE`, and only when the setting is off.
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
 * **Measured again on 2026-08-30, when half of that stopped being true.**
 * Thirteen windows, both editors: the channel no longer comes up by itself at
 * all. `/ide` at the start of eight windows -- both editors, both values of the
 * setting, against a Claude Code extension that was installed, live and
 * activated -- showed `None` as the current choice every time. It comes up when
 * a person asks for it and not otherwise, and then it holds. Which also settles
 * what this function cannot do: with `wanted` false and the variable below set,
 * a `/ide` typed by hand connected anyway, and the agent named the file that was
 * open and the line that was selected. CLI 2.1.245, extension 2.1.251, VS Code
 * 1.135.0, Cursor 3.17.19. **The caveat travels with the fact:** that run
 * installed a copy of the extension into a directory of its own, because the
 * windows our runs open do not register Claude Code at all, so whether an
 * ordinary installation behaves the same is NOT established.
 *
 * **The price, and the half of it that did not come back.** Seen 2026-08-20, by
 * hand, in VS Code: the editor's own terminal took the focus away from our panel
 * every time a prompt was sent, and only ONE agent got the channel at all -- the
 * CLI says so itself: "Only one Claude Code instance can be connected to VS Code
 * at a time". The SECOND half held on 2026-08-30: a second terminal is told
 * `Failed to connect` and the first keeps what it has. The FIRST half was looked
 * for again with an instrument and NOT FOUND -- in Cursor, 163 samples over 25 s
 * after a prompt was sent on an open channel, 162 and 155 in the other two arms,
 * nothing moving, against a positive control that moved every one of the same
 * fields. Connecting was watched in both editors and moved nothing. SENDING in
 * VS Code, the editor and the moment of the original sighting, was not watched
 * at all. So the sentence that used to stand here -- that a panel of five agents
 * pays with its focus for a channel one of them has -- is refuted where it was
 * looked for and withdrawn nowhere.
 *
 * The owner's decision of 2026-08-20, off by default, stands as a decision; what
 * changed is its ground. What the setting bought whoever wanted the other side
 * of that trade was the unasked connection, and on 2.1.245 there is no unasked
 * connection to buy. The setting is left standing exactly as it is: what to do
 * with one that governs nothing is the owner's to decide.
 *
 * **Why `false` and never `true`.** On the path it governs this is the one
 * answer the CLI takes as final: `CLAUDE_CODE_AUTO_CONNECT_IDE === false`
 * returns before every other check for connecting unasked. Final on THAT path
 * and no other -- 2026-08-30 measured a `/ide` typed by hand connecting with
 * this very variable set. It has four other reasons to connect, none of them
 * seen firing on 2.1.245, and a build that wrote `true` here would be claiming
 * a decision it did not make; leaving the name unset leaves those four exactly
 * as they were.
 *
 * The person's own delta is applied after this and wins, which is the same
 * order everything else in the composed rule follows.
 */
export function ideChannelEnv(wanted: boolean): Record<string, string> {
  return wanted ? {} : { CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' };
}
