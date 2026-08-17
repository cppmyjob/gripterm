/**
 * Throwaway measurement stand for 14-m3-plan.md, step M3.2 -- the pty gate.
 *
 * Stage A, which is what closes the gate: does our node-pty load inside the
 * extension host of THIS editor, whose ABI is not the ABI of any Node on the
 * machine? VS Code 1.133 runs ABI 146 and Cursor 3.13 runs ABI 143, measured in
 * the M3.1 protocol, while the Node on PATH here is ABI 127.
 *
 * Three more answers come free with the same spawn and are recorded because
 * they are cheap here and expensive later:
 *   * (6) exit code and signal;
 *   * (8) WHOSE pid node-pty reports under ConPTY -- the child's or the
 *     console host's. Restoration, the /rename mirror (M2.19) and orphan
 *     removal all stand on that pid, so a console pid would break O4 silently;
 *   * (2) how long the first output takes, against the 31 ms of A13.
 *
 * Nothing here moves into `packages/`. The output is a JSON protocol.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type * as NodePty from 'node-pty';

const MARKER = 'gripterm-probe-ok';
const SPAWN_TIMEOUT_MS = 15000;

interface LoadReport {
  readonly requiredFrom: string | null;
  readonly candidates: Record<string, string[] | 'MISSING'>;
  readonly loaded: boolean;
  readonly loadMs: number | null;
  readonly error: string | null;
}

interface SpawnReport {
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

interface Protocol {
  writtenAt: string;
  readonly editor: Record<string, string | undefined>;
  readonly runtime: Record<string, string | undefined>;
  load: LoadReport | null;
  spawns: SpawnReport[];
}

function listDir(directory: string): string[] | 'MISSING' {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : 'MISSING';
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/**
 * Load the addon and say exactly where it came from.
 *
 * `require('node-pty')` returning an object is NOT proof: its `spawn` is a
 * function before any .node file is touched. Measured 2026-08-17 with the
 * package installed but its build scripts skipped -- a probe that stopped here
 * reported success. Only a running pty proves the load, so this function
 * reports the load and the caller spawns.
 */
function loadPty(): { pty: typeof NodePty | null; report: LoadReport } {
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
      report: {
        requiredFrom: packageDir,
        candidates,
        loaded: true,
        loadMs: Date.now() - startedAt,
        error: null,
      },
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
async function probeSpawn(
  pty: typeof NodePty,
  what: string,
  file: string,
  args: string[],
  selfPidPattern: RegExp | null,
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
    const timer = setTimeout(() => { finish(`no exit within ${String(SPAWN_TIMEOUT_MS)} ms`); }, SPAWN_TIMEOUT_MS);

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

async function measure(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<string> {
  const protocol: Protocol = {
    writtenAt: new Date().toISOString(),
    editor: {
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      version: vscode.version,
    },
    runtime: {
      node: process.versions.node,
      electron: process.versions['electron'],
      modulesAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    load: null,
    spawns: [],
  };

  const { pty, report } = loadPty();
  protocol.load = report;
  log.appendLine(`node-pty loaded: ${String(report.loaded)}${report.error === null ? '' : ` (${report.error})`}`);

  if (pty !== null) {
    protocol.spawns.push(
      await probeSpawn(pty, 'cmd echo', 'cmd.exe', ['/c', `echo ${MARKER}`], null),
    );
    // PowerShell prints its own pid, so the two pids can be compared instead of
    // assumed equal.
    protocol.spawns.push(
      await probeSpawn(
        pty,
        'powershell self pid',
        'powershell.exe',
        ['-NoProfile', '-Command', `Write-Output "${MARKER} pid=$PID"`],
        /pid=(\d+)/u,
      ),
    );
  }

  const directory = path.join(context.extensionPath, 'results');
  const file = path.join(directory, `${sanitize(vscode.env.appName)}-${sanitize(vscode.version)}.json`);
  fs.mkdirSync(directory, { recursive: true });
  protocol.writtenAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(protocol, null, 2)}\n`, 'utf8');
  log.appendLine(`protocol written: ${file}`);
  return file;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Spike: pty and screen');
  context.subscriptions.push(log);

  const run = (): void => {
    measure(context, log).then(
      (file) => { log.appendLine(`done: ${file}`); },
      (error: unknown) => { log.appendLine(`FAILED: ${String(error)}`); },
    );
  };

  context.subscriptions.push(vscode.commands.registerCommand('spikePtyScreen.measure', run));
  run();
}

export function deactivate(): void {
  // Nothing to do yet: stage A leaves no pty alive.
}
