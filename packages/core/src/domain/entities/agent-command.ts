/**
 * A command line to start an agent, as data.
 *
 * The seam of decision №34, and the third axis §4.4 originally missed. WHICH
 * flags an agent takes is knowledge of one CLI and lives under
 * `domain/agents/<name>/`; HOW a command reaches a terminal -- as the terminal
 * process itself, or as a line typed into a shell -- is knowledge of the editor
 * and lives in `domain/services/`. Neither may import the other, so the two meet
 * on this shape.
 *
 * It is a vector and not a string on purpose: an argv needs no quoting, and the
 * one mode that must quote it is the one that pays for it (`shell-quoting.ts`).
 */
export interface AgentCommand {
  /** Absolute path to the executable. Never a bare name: PATH belongs to the terminal, not to us. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Added to the terminal's environment, not a replacement for it. */
  readonly env: Readonly<Record<string, string>>;
}
