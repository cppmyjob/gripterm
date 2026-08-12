import { runCli } from './cli-run';

/** One line of version text. Anything larger is not an answer to this question. */
const MAX_OUTPUT_BYTES = 65_536;

export interface VersionProbe {
  /** What the program printed on stdout, trimmed, or `null` when it did not answer. */
  readonly output: string | null;
  /** Why there is no output, in words, or `null` when there is. */
  readonly failure: string | null;
}

/**
 * Runs `<executable> --version` and brings back what it said.
 *
 * WHY A RUN AND NOT A FILE. The CLI's own update journal reports upgrades that
 * did not happen: `~/.claude/.last-update-result.json` recorded a successful
 * 2.1.225 -> 2.1.226 twice while the binary on disk stayed byte-identical to
 * 2.1.225 (measured 2026-08-09 and 2026-08-10). The only thing that answers
 * "which build will run" is the build, run.
 *
 * The spawning itself is `runCli`'s -- shared with the reader of
 * `agents --json`, because both are the same delicate half-page: no shell, a
 * bounded answer, a hard timeout, a synchronous throw to catch, and a failure
 * that comes back as a value. Two copies of that would be two answers to the
 * same question, diverging where nobody looks.
 */
export async function probeVersionOutput(
  executablePath: string,
  timeoutMs: number
): Promise<VersionProbe> {
  const run = await runCli(executablePath, ['--version'], {
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return { output: run.stdout, failure: run.failure };
}
