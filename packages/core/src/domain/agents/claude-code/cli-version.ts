/**
 * The Claude Code CLI build that every fact in the design of this extension was
 * measured against. M1.14 compares the installed CLI with this pin and warns on
 * a mismatch.
 *
 * The comparison must be made against what actually runs. The CLI's own update
 * journal is not a substitute: it reported a successful 2.1.225 -> 2.1.226
 * upgrade twice while the launched binary stayed byte-identical to 2.1.225.
 */
export const SUPPORTED_CLI_VERSION = '2.1.225';

const VERSION_PREFIX = /^\s*(\d+\.\d+\.\d+)/;

/**
 * Extracts the version from `claude --version` output, which is shaped like
 * "2.1.225 (Claude Code)". Returns undefined when the output carries no
 * leading version, so that a changed output format degrades into a warning
 * rather than into a wrong comparison.
 */
export function parseCliVersion(output: string): string | undefined {
  const match = VERSION_PREFIX.exec(output);
  return match?.[1];
}

/**
 * True when the installed CLI is exactly the pinned build. Deliberately strict:
 * a patch release can move any of the measured behaviours, and the point of the
 * check is to notice that, not to tolerate it.
 */
export function isSupportedCliVersion(output: string): boolean {
  return parseCliVersion(output) === SUPPORTED_CLI_VERSION;
}
