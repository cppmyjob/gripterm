/**
 * Loading node-pty inside an editor, and the one rule stage A left behind.
 *
 * `require('node-pty')` returning an object is NOT proof of a working addon:
 * its `spawn` is a function long before any .node file is touched. Measured
 * 2026-08-17 with the package installed and its build scripts skipped -- a probe
 * that stopped at `typeof spawn === 'function'` reported success on a package
 * whose `build/Release` was missing entirely. Only a running process proves the
 * load, so this module reports where the addon came from and the callers spawn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as NodePty from 'node-pty';

export const MARKER = 'gripterm-probe-ok';

export interface LoadReport {
  readonly requiredFrom: string | null;
  readonly candidates: Record<string, string[] | 'MISSING'>;
  readonly loaded: boolean;
  readonly loadMs: number | null;
  readonly error: string | null;
}

export interface SpawnReport {
  readonly what: string;
  spawned: boolean;
  /** What node-pty called the process id. */
  reportedPid: number | null;
  /** What the process itself says its pid is. The two must agree (question 8). */
  selfReportedPid: number | null;
  firstDataMs: number | null;
  echoed: boolean;
  exitCode: number | null;
  signal: number | null;
  error: string | null;
  /** First 400 characters of what came back, for the eyes. */
  head: string;
}

function listDir(directory: string): string[] | 'MISSING' {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : 'MISSING';
}

/** Load the addon and say exactly where it came from. */
export function loadPty(): { pty: typeof NodePty | null; report: LoadReport } {
  const candidates: Record<string, string[] | 'MISSING'> = {};
  let packageDir: string | null = null;
  try {
    packageDir = path.dirname(require.resolve('node-pty/package.json'));
    candidates['build/Release'] = listDir(path.join(packageDir, 'build', 'Release'));
    const key = `prebuilds/${process.platform}-${process.arch}`;
    candidates[key] = listDir(path.join(packageDir, 'prebuilds', `${process.platform}-${process.arch}`));
  } catch (error) {
    return {
      pty: null,
      report: { requiredFrom: null, candidates, loaded: false, loadMs: null, error: `resolve failed: ${String(error)}` },
    };
  }

  const startedAt = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as typeof NodePty;
    return {
      pty,
      report: { requiredFrom: packageDir, candidates, loaded: true, loadMs: Date.now() - startedAt, error: null },
    };
  } catch (error) {
    return {
      pty: null,
      report: {
        requiredFrom: packageDir,
        candidates,
        loaded: false,
        loadMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    };
  }
}

/**
 * Run one command under a pty and report what came back.
 *
 * `selfPidPattern` lets the command name its OWN pid so it can be compared with
 * the pid node-pty reports -- question 8, and the one with the sharpest teeth:
 * under ConPTY the console host is a process too, and a pid that belongs to it
 * would pass every test we have while breaking restoration on a real machine.
 */
export async function probeSpawn(
  pty: typeof NodePty,
  what: string,
  file: string,
  args: string[],
  selfPidPattern: RegExp | null,
  timeoutMs = 15000,
): Promise<SpawnReport> {
  const report: SpawnReport = {
    what,
    spawned: false,
    reportedPid: null,
    selfReportedPid: null,
    firstDataMs: null,
    echoed: false,
    exitCode: null,
    signal: null,
    error: null,
    head: '',
  };

  await new Promise<void>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (why: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (why !== null && report.error === null) {
        report.error = why;
      }
      resolve();
    };
    const timer = setTimeout(() => { finish(`no exit within ${String(timeoutMs)} ms`); }, timeoutMs);

    let child: NodePty.IPty;
    try {
      child = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      });
    } catch (error) {
      clearTimeout(timer);
      finish(`spawn threw: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    report.spawned = true;
    report.reportedPid = child.pid;

    child.onData((data) => {
      report.firstDataMs ??= Date.now() - startedAt;
      report.head = (report.head + data).slice(0, 400);
      if (data.includes(MARKER)) {
        report.echoed = true;
      }
      if (selfPidPattern !== null && report.selfReportedPid === null) {
        const match = selfPidPattern.exec(report.head);
        if (match?.[1] !== undefined) {
          report.selfReportedPid = Number(match[1]);
        }
      }
    });

    child.onExit(({ exitCode, signal }) => {
      report.exitCode = exitCode;
      report.signal = signal ?? null;
      clearTimeout(timer);
      // The tail of the output can land in the same tick as the exit.
      setTimeout(() => { finish(null); }, 300);
    });
  });

  return report;
}
