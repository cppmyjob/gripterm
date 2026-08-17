/**
 * Asking Windows about a process, without believing anything we did not ask.
 *
 * Two questions matter to M3 and both are cheap here and expensive later:
 *   * is the pid we recorded still alive -- M3.5(d) waits for the answer to turn
 *     to "no" after a kill, because `TerminateProcess` is asynchronous and both
 *     restore gates read the machine immediately afterwards;
 *   * what hangs UNDER that pid -- because if the process we spawn is a launcher
 *     with the real agent as a child, then killing the recorded pid leaves the
 *     agent orphaned and O4 fails silently.
 */

import { execFile } from 'node:child_process';

export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string;
}

/** Alive as the OS sees it. Signal 0 tests existence, it does not deliver. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => { resolve(error === null ? stdout : `POWERSHELL FAILED: ${error.message}`); },
    );
  });
}

/**
 * The pid itself and everything descended from it, up to six generations.
 *
 * Six is arbitrary and named as such: it is far past anything a shell tree needs
 * and cheap, since the whole process list is fetched once and walked in memory.
 */
export async function processTree(root: number, timeoutMs = 20000): Promise<ProcessRow[] | string> {
  const script = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    '$want = New-Object System.Collections.Generic.HashSet[int]',
    `[void]$want.Add(${String(root)})`,
    'for ($i = 0; $i -lt 6; $i++) {',
    '  foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } }',
    '}',
    '$all | Where-Object { $want.Contains([int]$_.ProcessId) } |',
    '  ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.Name, ($_.CommandLine -replace "\\s+", " ")) -join "|" }',
  ].join('\n');

  const out = await runPowerShell(script, timeoutMs);
  if (out.startsWith('POWERSHELL FAILED')) {
    return out;
  }

  const rows: ProcessRow[] = [];
  for (const line of out.split(/\r?\n/u)) {
    const parts = line.split('|');
    if (parts.length < 3) {
      continue;
    }
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    if (!Number.isFinite(pid)) {
      continue;
    }
    rows.push({
      pid,
      parentPid,
      name: parts[2] ?? '',
      commandLine: (parts.slice(3).join('|') || '').slice(0, 300),
    });
  }
  return rows;
}

/**
 * Wait for a pid to stop answering, and say how long it took.
 *
 * Returns null if it never stopped within the ceiling -- which is a result, not
 * an error, and M3.5 needs to know the difference.
 */
export async function waitUntilGone(pid: number, ceilingMs = 5000, stepMs = 25): Promise<number | null> {
  const startedAt = Date.now();
  for (;;) {
    if (!isAlive(pid)) {
      return Date.now() - startedAt;
    }
    if (Date.now() - startedAt >= ceilingMs) {
      return null;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, stepMs); });
  }
}
