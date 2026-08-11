import { execFile } from 'node:child_process';

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
 * NO SHELL, and no argument we did not write: `execFile` spawns the program
 * directly, so a path with a space in it is a path with a space in it, and
 * nothing here needs quoting (the same win §4.4 took on the launch path).
 *
 * It never throws. Its caller is activation, and a missing `claude` is an
 * ordinary state of the world -- the person may not have installed it -- not a
 * reason for a window to come up without its extension.
 */
export async function probeVersionOutput(
  executablePath: string,
  timeoutMs: number
): Promise<VersionProbe> {
  return await new Promise<VersionProbe>((resolve) => {
    // `execFile` reports most failures through the callback and a few by
    // THROWING, synchronously, before the callback exists -- measured, not
    // guarded against on principle: handing it a `.ts` file on Windows raises
    // `spawn EFTYPE` on this line. Without this the "never throws" above would
    // have been a comment rather than a property.
    try {
      probe(executablePath, timeoutMs, resolve);
    } catch (error: unknown) {
      resolve({ output: null, failure: sentenceOf(error) });
    }
  });
}

function probe(
  executablePath: string,
  timeoutMs: number,
  resolve: (probe: VersionProbe) => void
): void {
  execFile(
    executablePath,
    ['--version'],
    {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      // Nothing flashes on screen while a window is coming up.
      windowsHide: true,
    },
    (error: unknown, stdout: string) => {
      if (error !== null) {
        // Missing, not executable, exited non-zero, or killed for taking too
        // long. The distinction belongs in the log line, not in the type: to
        // every caller here, all four mean the same -- no version was
        // established, and the pinned-version check has nothing to compare.
        resolve({ output: null, failure: sentenceOf(error) });
        return;
      }
      resolve({ output: stdout.trim(), failure: null });
    }
  );
}

/**
 * The one sentence worth putting in front of a person.
 *
 * `execFile` hands back an `Error` whose message already names what happened
 * ("spawn ... ENOENT", "Command failed: ...", "... was killed with SIGTERM"),
 * so the failure travels as text rather than as an object nobody downstream
 * would branch on.
 *
 * `String` rather than a check for `Error` and a fallback: the fallback would be
 * a branch no test on any platform could reach, which is the kind that quietly
 * stops being true. `String(error)` renders an `Error` as "Error: <message>",
 * and anything else as whatever it is.
 */
function sentenceOf(error: unknown): string {
  return String(error);
}
