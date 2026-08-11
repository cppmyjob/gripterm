import { join } from 'node:path';
import { probeVersionOutput } from '../../packages/core/src/infrastructure/cli-probe';

const GENEROUS_MS = 10_000;

describe('asking an executable which version it is', () => {
  it('returns what the program printed', async () => {
    // A real process, because everything this module does happens between us
    // and the operating system: a fake would be asserting our own stub. `node
    // --version` prints `v22.16.0` and exits 0, which is the same shape as
    // `claude --version`.
    const probe = await probeVersionOutput(process.execPath, GENEROUS_MS);

    expect(probe.failure).toBeNull();
    expect(probe.output).toMatch(/^v\d+\.\d+\.\d+/u);
    // Trimmed: the version goes into a log line and into a comparison, and a
    // trailing newline would make the second one fail on a correct CLI.
    expect(probe.output).not.toMatch(/\s$/u);
  });

  it('does not throw when the executable is not there', async () => {
    // The caller is activation. A refusal that throws would take the window's
    // whole activation with it, over a program the person may simply not have
    // installed.
    const probe = await probeVersionOutput(join(__dirname, 'no-such-program.exe'), GENEROUS_MS);

    expect(probe.output).toBeNull();
    expect(probe.failure).not.toBeNull();
  });

  it('reports a program that refused rather than pretending it answered', async () => {
    // `node --version` is fine; this file is not a program at all, so the shell
    // -- there is none -- cannot rescue it either.
    const probe = await probeVersionOutput(__filename, GENEROUS_MS);

    expect(probe.output).toBeNull();
    expect(probe.failure).not.toBeNull();
  });

  it('gives up rather than holding activation open', async () => {
    // One millisecond is shorter than any process start, so this measures the
    // timeout and not the program. Activation waits for this call, and a `claude`
    // that hangs would otherwise hang the extension host with it.
    const probe = await probeVersionOutput(process.execPath, 1);

    expect(probe.output).toBeNull();
    expect(probe.failure).not.toBeNull();
  });
});
