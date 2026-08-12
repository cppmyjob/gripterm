import { execFile } from 'node:child_process';

export interface CliRunOptions {
  /** How long the program may take before it is killed and reported as silent. */
  readonly timeoutMs: number;
  /**
   * How much it may say. Exceeding it is a FAILURE and never a truncation --
   * the caller of a truncated answer cannot tell it from a complete one.
   */
  readonly maxOutputBytes: number;
}

/** What a program said on standard output, or why there is nothing to read. */
export interface CliRun {
  /** Standard output, trimmed, or `null` when the program did not answer. */
  readonly stdout: string | null;
  /** Why there is no output, in words, or `null` when there is. */
  readonly failure: string | null;
}

/**
 * Runs a program and brings back what it printed.
 *
 * NO SHELL, and no argument the caller did not write: `execFile` spawns the
 * program directly, so a path with a space in it is a path with a space in it
 * and nothing here needs quoting -- the same win §4.4 took on the launch path.
 *
 * IT NEVER THROWS. Both callers are on paths where an exception is the wrong
 * kind of loud: activation, where a missing `claude` is an ordinary state of
 * the world, and the restore path, where it would be a window coming up with
 * its terminals missing. Every refusal comes back as a value.
 *
 * The four ways a run can fail -- missing, not executable, exited non-zero,
 * killed for taking too long or saying too much -- are deliberately one field
 * and not four. To every caller they mean the same thing: no answer was
 * established. The distinction belongs in the log line, and it is there, in
 * words, because the platform already writes them.
 */
export async function runCli(
  executablePath: string,
  args: readonly string[],
  options: CliRunOptions
): Promise<CliRun> {
  return await new Promise<CliRun>((resolve) => {
    // `execFile` reports most failures through the callback and a few by
    // THROWING, synchronously, before the callback exists -- measured, not
    // guarded against on principle: handing it a `.ts` file on Windows raises
    // `spawn EFTYPE` on this line. Without this the "never throws" above would
    // have been a comment rather than a property.
    try {
      spawn(executablePath, args, options, resolve);
    } catch (error: unknown) {
      resolve({ stdout: null, failure: sentenceOf(error) });
    }
  });
}

function spawn(
  executablePath: string,
  args: readonly string[],
  options: CliRunOptions,
  resolve: (run: CliRun) => void
): void {
  execFile(
    executablePath,
    [...args],
    {
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      // Nothing flashes on screen while a window is coming up.
      windowsHide: true,
    },
    (error: unknown, stdout: string) => {
      if (error !== null) {
        resolve({ stdout: null, failure: sentenceOf(error) });
        return;
      }
      resolve({ stdout: stdout.trim(), failure: null });
    }
  );
}

/**
 * The one sentence worth putting in front of a person.
 *
 * `execFile` hands back an `Error` whose message already names what happened
 * ("spawn ... ENOENT", "Command failed: ... <stderr>", "... was killed with
 * SIGTERM"), so the failure travels as text rather than as an object nobody
 * downstream would branch on. Standard error arrives inside it, which is where
 * a refusing CLI puts the only sentence that helps -- which flag, which build.
 *
 * `String` rather than a check for `Error` and a fallback: the fallback would be
 * a branch no test on any platform could reach, which is the kind that quietly
 * stops being true. `String(error)` renders an `Error` as "Error: <message>",
 * and anything else as whatever it is.
 */
function sentenceOf(error: unknown): string {
  return String(error);
}
