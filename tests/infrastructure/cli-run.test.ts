import { join } from 'node:path';
import { runCli } from '../../packages/core/src/infrastructure/cli-run';

const GENEROUS_MS = 10_000;
const PLENTY = 64 * 1024;

/**
 * Real processes throughout. Everything this module does happens between us and
 * the operating system, so a fake here would only assert our own stub -- and the
 * two cases that matter most (a program that says too much, a program that never
 * finishes) have no shape at all except the one the platform gives them.
 */
describe('running a program and bringing back what it said', () => {
  it('returns its output, trimmed', async () => {
    const run = await runCli(process.execPath, ['--version'], {
      timeoutMs: GENEROUS_MS,
      maxOutputBytes: PLENTY,
    });

    expect(run.failure).toBeNull();
    expect(run.stdout).toMatch(/^v\d+\.\d+\.\d+$/u);
  });

  it('does not throw when the program is not there', async () => {
    const run = await runCli(join(__dirname, 'no-such-program.exe'), ['--version'], {
      timeoutMs: GENEROUS_MS,
      maxOutputBytes: PLENTY,
    });

    expect(run.stdout).toBeNull();
    expect(run.failure).toContain('ENOENT');
  });

  it('does not throw when the path is not a program at all', async () => {
    // Measured on this platform: handing `execFile` a `.ts` file raises
    // synchronously, before the callback it would otherwise report through.
    const run = await runCli(__filename, [], { timeoutMs: GENEROUS_MS, maxOutputBytes: PLENTY });

    expect(run.stdout).toBeNull();
    expect(run.failure).not.toBeNull();
  });

  it('carries what a refusing program printed on stderr', async () => {
    // The shape `claude` itself refuses in: `error: unknown option '--x'` on
    // stderr, exit 1. Without the words, a caller could only report "it failed",
    // and the one thing a person needs is which flag this build does not know.
    const run = await runCli(
      process.execPath,
      ['-e', 'console.error("error: unknown option"); process.exit(1);'],
      { timeoutMs: GENEROUS_MS, maxOutputBytes: PLENTY }
    );

    expect(run.stdout).toBeNull();
    expect(run.failure).toContain('unknown option');
  });

  it('refuses output larger than it agreed to hold', async () => {
    // The asymmetry that decides this: a truncated listing read as a listing is
    // a live session we did not see, which becomes a second `--resume` on it. A
    // refusal is a click; a silent truncation is an interleaved transcript.
    const run = await runCli(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(200000));'],
      { timeoutMs: GENEROUS_MS, maxOutputBytes: 1024 }
    );

    expect(run.stdout).toBeNull();
    expect(run.failure).not.toBeNull();
  });

  it('gives up rather than waiting for a program that never finishes', async () => {
    const run = await runCli(process.execPath, ['-e', 'setTimeout(() => undefined, 60000);'], {
      timeoutMs: 50,
      maxOutputBytes: PLENTY,
    });

    expect(run.stdout).toBeNull();
    expect(run.failure).not.toBeNull();
  });
});
