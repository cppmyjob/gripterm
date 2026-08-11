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

/** What `<claude> --version` answered: its output, or why there is none. */
export interface CliVersionAnswer {
  readonly output: string | null;
  readonly failure: string | null;
}

export interface CliVersionReport {
  readonly version: string | null;
  /** `info` when the installed build is the pinned one, `warn` otherwise. */
  readonly level: 'info' | 'warn';
  readonly message: string;
}

/**
 * What to say about the CLI this machine will actually run.
 *
 * Four answers rather than a boolean, because the four are acted on
 * differently by the person reading them: the same build, a different build, a
 * build that would not say, and a build whose answer we could not read. The
 * last two are NOT reported as a mismatch -- claiming a version difference we
 * did not establish would send somebody to reinstall something that is fine.
 *
 * A warning and never a refusal. Every fact this extension rests on was
 * measured against the pin, so a different build is a reason to distrust our
 * facts -- not a reason to stop a person from using their own installation.
 */
export function describeCliVersion(answer: CliVersionAnswer): CliVersionReport {
  if (answer.output === null) {
    return {
      version: null,
      level: 'warn',
      message: `could not ask Claude Code which version it is: ${answer.failure ?? 'no answer'}`,
    };
  }

  const version = parseCliVersion(answer.output);
  if (version === undefined) {
    return {
      version: null,
      level: 'warn',
      message: `Claude Code answered "${answer.output}", which this build cannot read as a version`,
    };
  }
  if (version === SUPPORTED_CLI_VERSION) {
    return { version, level: 'info', message: `Claude Code ${version}, the build this was measured against` };
  }
  return {
    version,
    level: 'warn',
    message: `Claude Code ${version} is installed; this build was measured against ${SUPPORTED_CLI_VERSION}. Everything should still work, and anything that does not is worth reporting with both numbers`,
  };
}
