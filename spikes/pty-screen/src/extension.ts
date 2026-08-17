/**
 * Throwaway measurement stand for 14-m3-plan.md, step M3.2 -- the pty gate.
 *
 * Stage A (committed 2026-08-17) closed the gate itself: does our node-pty load
 * inside the extension host of THIS editor, whose ABI is not the ABI of any Node
 * on the machine. VS Code 1.133 runs ABI 146 and Cursor 3.13 runs ABI 143, while
 * the Node on PATH here is ABI 127. It also answered (8) -- whose pid node-pty
 * reports -- and the easy half of (6).
 *
 * Stage B is the rest of the ten. The pty half lives in `stage-b.ts`: (2) a live
 * `claude`, (6) the exit code on `kill()` and whether a descendant survives it,
 * (7) surviving the death of the extension host, (9) the environment in both
 * directions, (10) a 64 KiB write hashed at the far end. The screen half lives
 * in `screen.ts`: (3) the channel and where back-pressure starts, (4) the
 * unicode twins, (5) a resize under a live stream.
 *
 * The whole run is automatic on activation, because every owner action is a step
 * that can be skipped, mistyped or forgotten, and the protocol is worth more
 * when it costs one launch. The single exception is question (7), which by
 * definition needs the host to die: the stand arms two children, reloads the
 * window itself, and reads the answer on the next activation.
 *
 * Nothing here moves into `packages/`. The output is a JSON protocol.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { loadPty, probeSpawn, MARKER, type LoadReport, type SpawnReport } from './pty';
import { armSurvivor, checkSurvivor, runStageB, stampBeforeReload, type StageBReport } from './stage-b';
import { runScreenHalf, showLiveClaude, ScreenBoard, VIEW_ID, type ScreenReport } from './screen';

interface Protocol {
  writtenAt: string;
  readonly editor: Record<string, string | undefined>;
  readonly runtime: Record<string, string | undefined>;
  load: LoadReport | null;
  spawns: SpawnReport[];
  stageB: StageBReport | null;
  screen: ScreenReport | null;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/** Where `claude` gets launched from: the owner's folder if there is one. */
function workingDirectory(context: vscode.ExtensionContext): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
}

/**
 * The previous protocol, if this window has already written one.
 *
 * It is read for one reason: question (7) spans two activations, and the second
 * one must not throw away what the first measured.
 */
function readPrevious(file: string): Protocol | null {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Protocol) : null;
  } catch {
    return null;
  }
}

async function measure(
  context: vscode.ExtensionContext,
  board: ScreenBoard,
  log: vscode.OutputChannel,
): Promise<string> {
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
    stageB: null,
    screen: null,
  };

  const resultsDir = path.join(context.extensionPath, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${sanitize(vscode.env.appName)}-${sanitize(vscode.version)}.json`);
  const previous = readPrevious(file);

  const { pty, report } = loadPty();
  protocol.load = report;
  log.appendLine(`node-pty loaded: ${String(report.loaded)}${report.error === null ? '' : ` (${report.error})`}`);

  if (pty === null) {
    fs.writeFileSync(file, `${JSON.stringify(protocol, null, 2)}\n`, 'utf8');
    return file;
  }

  // Stage A, kept because it is cheap and it re-proves the gate on every launch.
  protocol.spawns.push(await probeSpawn(pty, 'cmd echo', 'cmd.exe', ['/c', `echo ${MARKER}`], null));
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

  // Question (7) first: whatever was armed before this window died is either
  // still alive or not, and every second spent measuring something else makes
  // the answer less about the host's death and more about time passing.
  const survival = await checkSurvivor(resultsDir, log);

  const stageB = await runStageB(pty, context, resultsDir, workingDirectory(context), log);
  stageB.survival = survival ?? previous?.stageB?.survival ?? null;
  protocol.stageB = stageB;

  try {
    protocol.screen = await runScreenHalf(board, pty, context, log);
  } catch (error) {
    protocol.screen = {
      viewResolved: false,
      resolveCount: board.resolveCount,
      firstFit: null,
      twins: null,
      channel: [],
      resizeUnderStream: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }

  protocol.writtenAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(protocol, null, 2)}\n`, 'utf8');
  log.appendLine(`protocol written: ${file}`);

  // Question (7) needs this host dead, so the stand kills it itself: the
  // protocol is on disk by now and the armed children are on disk by pid, so
  // the second activation finds both. It cannot loop -- once `survival` is
  // filled in, nothing arms again.
  if (stageB.survival === null) {
    const pids = await armSurvivor(pty, resultsDir, workingDirectory(context), log);
    if (pids.length > 0) {
      log.appendLine('reloading the window in 2 s to kill this extension host');
      setTimeout(() => {
        stampBeforeReload(resultsDir);
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 2000);
    }
  } else {
    // Everything measured. What is left is the owner's eyes on question (4).
    const pid = await showLiveClaude(board, pty, workingDirectory(context));
    log.appendLine(`live claude on the screen: pid ${String(pid)}`);
  }
  return file;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Spike: pty and screen');
  context.subscriptions.push(log);

  const board = new ScreenBoard(context, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, board, {
      // Measured in M3.1: the state of a panel view survives hiding with this on.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const run = (): void => {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Spike: measuring pty and screen (M3.2)' },
      async () => {
        try {
          const file = await measure(context, board, log);
          log.appendLine(`done: ${file}`);
        } catch (error) {
          log.appendLine(`FAILED: ${String(error)}`);
          void vscode.window.showErrorMessage(`Spike failed: ${String(error)}`);
        }
      },
    );
  };

  context.subscriptions.push(vscode.commands.registerCommand('spikePtyScreen.measure', run));
  context.subscriptions.push(
    vscode.commands.registerCommand('spikePtyScreen.liveClaude', () => {
      const { pty } = loadPty();
      if (pty !== null) {
        void showLiveClaude(board, pty, workingDirectory(context));
      }
    }),
  );
  run();
}

export function deactivate(): void {
  // Deliberately empty. Every pty this stand opens is killed by the scenario
  // that opened it, except the two armed for question (7) -- and those are
  // meant to outlive us. The next activation kills whichever survived.
}
