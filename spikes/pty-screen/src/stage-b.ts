/**
 * M3.2 stage B, the pty half: the five answers that need no screen.
 *
 * Stage A closed the gate itself (does the addon load) plus (6) partially and
 * (8). What is measured here:
 *   (2) how long a LIVE `claude` takes to say its first word, against the 31 ms
 *       of A13 -- and, for free and more valuable, which DEC private modes it
 *       turns on, because M3.7 has to render them and M3.8 has to not break
 *       bracketed paste;
 *   (6) the exit code and signal on `kill()`, which is the input of
 *       `exitVerdict` in M3.3 and was NOT measured in stage A: stage A saw a
 *       process end by itself;
 *   (7) whether the child survives the death of the extension host -- and the
 *       killing of it afterwards BY RECORDED PID, which is exactly the mechanism
 *       M3.5 plans to use and has never been run;
 *   (9) the environment, in both directions: what the editor gives its own
 *       terminals that the extension host does not have, and the reverse;
 *   (10) a single write of 64 KiB with the hash compared at the far end (A11).
 *
 * Nothing here moves into `packages/`. The output is a JSON protocol.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type * as NodePty from 'node-pty';

import { isAlive, processTree, waitUntilGone, type ProcessRow } from './win';

const CLAUDE_SETTLE_MS = 4000;
const FILE_WAIT_MS = 20000;

/** node-pty's own shape for `onExit`; `signal` is optional, not nullable. */
interface ExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// (6) what `kill()` looks like from our side
// ---------------------------------------------------------------------------

export interface KillReport {
  readonly what: string;
  pid: number | null;
  sawFirstOutput: boolean;
  exitCode: number | null;
  signal: number | null;
  msToExitEvent: number | null;
  /**
   * How long after the exit event the pid stopped answering signal 0. M3.5(d)
   * waits on this, because both restore gates read the machine right after.
   */
  msUntilPidGone: number | null;
  error: string | null;
}

async function measureKill(pty: typeof NodePty, what: string, file: string, args: string[]): Promise<KillReport> {
  const report: KillReport = {
    what,
    pid: null,
    sawFirstOutput: false,
    exitCode: null,
    signal: null,
    msToExitEvent: null,
    msUntilPidGone: null,
    error: null,
  };

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
    report.error = `spawn threw: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  report.pid = child.pid;
  const exited = new Promise<ExitEvent>((resolve) => {
    child.onExit(resolve);
  });
  child.onData(() => { report.sawFirstOutput = true; });

  // Let it become a real process before killing it: killing a pty in the same
  // tick as the spawn measures the spawn, not the kill.
  await delay(1500);

  const killedAt = Date.now();
  child.kill();

  const outcome = await Promise.race([
    exited,
    delay(10000).then(() => null),
  ]);

  if (outcome === null) {
    report.error = 'no exit event within 10000 ms after kill()';
  } else {
    report.exitCode = outcome.exitCode;
    report.signal = outcome.signal ?? null;
    report.msToExitEvent = Date.now() - killedAt;
  }

  if (report.pid !== null) {
    report.msUntilPidGone = await waitUntilGone(report.pid);
  }
  return report;
}

// ---------------------------------------------------------------------------
// (6b) does a DESCENDANT of the child survive our kill -- the real O4 question
// ---------------------------------------------------------------------------

/**
 * `kill()` on the pty, with a grandchild running under the shell.
 *
 * This is not in the plan's list of ten and it belongs there. The plan asks for
 * the exit code on `kill`; O4 asks something sharper: `claude` runs builds and
 * test suites, so at the moment we kill it there is usually a node or a pnpm
 * under it. node-pty's own answer to this -- enumerate the console process list
 * and kill every pid on it -- was measured broken here on 2026-08-17: it forks
 * `conpty_console_list_agent`, and by the time the fork runs, `_ptyNative.kill`
 * has already closed the pseudoconsole, so the agent dies on `AttachConsole
 * failed` and the promise falls through to its 5 s timeout. So the descendants
 * are not killed by that path, and whether they die at all is a question about
 * ConPTY, not about node-pty. It has to be measured, not assumed.
 */
export interface DescendantKillReport {
  shellPid: number | null;
  grandchildPid: number | null;
  treeBeforeKill: ProcessRow[] | string | null;
  shellExitCode: number | null;
  shellSignal: number | null;
  samples: Array<{ atMs: number; shellAlive: boolean; grandchildAlive: boolean }>;
  grandchildNeededOurKill: boolean;
  error: string | null;
}

async function measureDescendantKill(pty: typeof NodePty): Promise<DescendantKillReport> {
  const report: DescendantKillReport = {
    shellPid: null,
    grandchildPid: null,
    treeBeforeKill: null,
    shellExitCode: null,
    shellSignal: null,
    samples: [],
    grandchildNeededOurKill: false,
    error: null,
  };

  let child: NodePty.IPty;
  try {
    child = pty.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
  } catch (error) {
    report.error = `spawn threw: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  report.shellPid = child.pid;
  let seen = '';
  child.onData((data) => { seen = (seen + data).slice(-4000); });
  child.onExit((event: ExitEvent) => {
    report.shellExitCode = event.exitCode;
    report.shellSignal = event.signal ?? null;
  });

  await delay(1500);
  child.write('node -e "console.log(\'GRANDCHILD pid=\'+process.pid); setInterval(()=>{},1000)"\r');

  const startedAt = Date.now();
  let match: RegExpExecArray | null = null;
  while (match === null && Date.now() - startedAt < 20000) {
    match = /GRANDCHILD pid=(\d+)/u.exec(seen);
    if (match === null) {
      await delay(50);
    }
  }
  if (match?.[1] === undefined) {
    report.error = `no grandchild within 20000 ms; tail: ${JSON.stringify(seen.slice(-300))}`;
    child.kill();
    return report;
  }
  report.grandchildPid = Number(match[1]);
  report.treeBeforeKill = await processTree(child.pid);

  child.kill();

  // Sampled past node-pty's own 5 s timeout, because that is when its fallback
  // "kill the shell pid" would land if it landed at all.
  let previous = 0;
  for (const at of [500, 2000, 6000]) {
    await delay(at - previous);
    previous = at;
    report.samples.push({
      atMs: at,
      shellAlive: isAlive(child.pid),
      grandchildAlive: isAlive(report.grandchildPid),
    });
  }

  if (isAlive(report.grandchildPid)) {
    report.grandchildNeededOurKill = true;
    try {
      process.kill(report.grandchildPid, 'SIGKILL');
    } catch {
      // Already gone between the check and the kill: nothing to do.
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// (9) the environment, in both directions
// ---------------------------------------------------------------------------

/**
 * Values are redacted unless the name is one we deliberately want to read.
 *
 * The results file is not committed, but this protocol gets quoted into a
 * document that is, and an environment holds tokens. Anything whose name smells
 * of a secret is redacted even when it matches the readable list.
 */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|_KEY$|SESSION/iu;
const READABLE_NAME =
  /^(PATH|VIRTUAL_ENV|CONDA_[A-Z0-9_]*|PYTHON[A-Z0-9_]*|TERM[A-Z0-9_]*|VSCODE_[A-Z0-9_]*|ELECTRON_[A-Z0-9_]*|LANG|LC_[A-Z0-9_]*|COLORTERM|SHELL|NODE_[A-Z0-9_]*|NPM_[A-Z0-9_]*|CLAUDE_[A-Z0-9_]*|GIT_[A-Z0-9_]*|CURSOR_[A-Z0-9_]*|CHROME_[A-Z0-9_]*|ORIGINAL_[A-Z0-9_]*)$/u;

function show(key: string, value: string): string {
  if (SECRET_NAME.test(key)) {
    return `<redacted, ${String(value.length)} chars>`;
  }
  if (!READABLE_NAME.test(key.toUpperCase())) {
    return `<hidden, ${String(value.length)} chars>`;
  }
  return value.length > 900 ? `${value.slice(0, 900)}…(+${String(value.length - 900)})` : value;
}

/** Windows environment names are case-insensitive; the diff must be too. */
function upperKeys(env: Record<string, string>): Map<string, { key: string; value: string }> {
  const map = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(env)) {
    map.set(key.toUpperCase(), { key, value });
  }
  return map;
}

export interface EnvDiff {
  readonly left: string;
  readonly right: string;
  onlyInLeft: string[];
  onlyInRight: string[];
  different: Array<{ key: string; left: string; right: string }>;
  pathOnlyInLeft: string[];
  pathOnlyInRight: string[];
}

function splitPath(value: string | undefined): string[] {
  return (value ?? '').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

function diffEnv(leftName: string, left: Record<string, string>, rightName: string, right: Record<string, string>): EnvDiff {
  const l = upperKeys(left);
  const r = upperKeys(right);
  const diff: EnvDiff = {
    left: leftName,
    right: rightName,
    onlyInLeft: [],
    onlyInRight: [],
    different: [],
    pathOnlyInLeft: [],
    pathOnlyInRight: [],
  };

  for (const [upper, entry] of l) {
    const other = r.get(upper);
    if (other === undefined) {
      diff.onlyInLeft.push(entry.key);
    } else if (other.value !== entry.value) {
      diff.different.push({ key: entry.key, left: show(entry.key, entry.value), right: show(entry.key, other.value) });
    }
  }
  for (const [upper, entry] of r) {
    if (!l.has(upper)) {
      diff.onlyInRight.push(entry.key);
    }
  }

  const leftPath = new Set(splitPath(l.get('PATH')?.value).map((s) => s.toLowerCase()));
  const rightPath = new Set(splitPath(r.get('PATH')?.value).map((s) => s.toLowerCase()));
  for (const segment of leftPath) {
    if (!rightPath.has(segment)) {
      diff.pathOnlyInLeft.push(segment);
    }
  }
  for (const segment of rightPath) {
    if (!leftPath.has(segment)) {
      diff.pathOnlyInRight.push(segment);
    }
  }

  diff.onlyInLeft.sort();
  diff.onlyInRight.sort();
  diff.different.sort((a, b) => a.key.localeCompare(b.key));
  return diff;
}

async function waitForFile(file: string, ceilingMs: number): Promise<string | null> {
  const startedAt = Date.now();
  for (;;) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      // The writer is atomic enough for a spike, but a partial read is still
      // possible on a slow disk; a JSON that does not parse means "wait more".
      try {
        JSON.parse(text) as unknown;
        return text;
      } catch {
        // fall through and retry
      }
    }
    if (Date.now() - startedAt >= ceilingMs) {
      return null;
    }
    await delay(200);
  }
}

export interface EnvReport {
  hostKeyCount: number;
  editorTerminalKeyCount: number | null;
  ourPtyKeyCount: number | null;
  editorTerminalError: string | null;
  ourPtyError: string | null;
  /**
   * What the editor's own terminal actually did, so a missing dump is a fact and
   * not a shrug: the pid it got (or none), the code it exited with, and why.
   */
  editorTerminalShellPath: string;
  editorTerminalProcessId: number | null;
  editorTerminalExitCode: number | null;
  editorTerminalExitReason: number | null;
  /**
   * The second probe, through the editor's DEFAULT profile plus `sendText`.
   * Measured 2026-08-17: a terminal created with an explicit `shellPath` never
   * got a process at all in the development host -- `processId` did not resolve
   * in 20 s -- so the question had to be asked a second way before "the editor
   * adds nothing" could be said about anything.
   */
  /** Which interpreter produced both dumps; only one column at a time. */
  dumper: string;
  defaultProfileShell: string;
  defaultProfileProcessId: number | null;
  defaultProfileError: string | null;
  /** Observations that tell a terminal which never opened from one which opened and did nothing. */
  workspaceTrusted: boolean;
  terminalsOpenBefore: number;
  didOpenTerminalFire: boolean;
  /**
   * One half of the answer read straight from configuration. It does not need a
   * terminal at all, and it is exactly what M3.4(3) has to replay; the half it
   * cannot see is `environmentVariableCollection` from other extensions.
   */
  configuredTerminalEnvWindows: unknown;
  /** What the editor's terminal has that the extension host has not, and back. */
  hostVsEditorTerminal: EnvDiff | null;
  /** Our pty against the editor's terminal: the delta M3.4(3) has to close. */
  editorTerminalVsOurPty: EnvDiff | null;
  note: string;
}

async function measureEnvironments(
  pty: typeof NodePty,
  context: vscode.ExtensionContext,
  resultsDir: string,
): Promise<EnvReport> {
  const script = path.join(context.extensionPath, 'scripts', 'env-dump.ps1');
  // Node does the dumping when PowerShell cannot. Measured 2026-08-17 in Cursor:
  // its extension host environment holds two names differing only in case, and
  // the `env:` provider throws instead of enumerating. Node merges them.
  const nodeScript = path.join(context.extensionPath, 'scripts', 'env-dump.js');
  const useNode = process.env['GRIPTERM_SPIKE_ENV_DUMPER'] !== 'powershell';
  const editorFile = path.join(resultsDir, 'env-editor-terminal.json');
  const ptyFile = path.join(resultsDir, 'env-our-pty.json');
  for (const file of [editorFile, ptyFile]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
    }
  }

  // An absolute path, because `shellPath` is not a shell lookup: the terminal
  // service hands it to its own pty host, and a bare name that our node-pty
  // resolves through PATH is not guaranteed to resolve there.
  const powershell = path.join(
    process.env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  const report: EnvReport = {
    hostKeyCount: Object.keys(process.env).length,
    editorTerminalKeyCount: null,
    ourPtyKeyCount: null,
    editorTerminalError: null,
    ourPtyError: null,
    editorTerminalShellPath: powershell,
    editorTerminalProcessId: null,
    editorTerminalExitCode: null,
    editorTerminalExitReason: null,
    dumper: useNode ? 'node' : 'powershell',
    defaultProfileShell: vscode.env.shell,
    defaultProfileProcessId: null,
    defaultProfileError: null,
    workspaceTrusted: vscode.workspace.isTrusted,
    terminalsOpenBefore: vscode.window.terminals.length,
    didOpenTerminalFire: false,
    configuredTerminalEnvWindows:
      vscode.workspace.getConfiguration('terminal.integrated.env').get('windows') ?? null,
    hostVsEditorTerminal: null,
    editorTerminalVsOurPty: null,
    note:
      'The editor terminal runs powershell with -NoProfile on purpose: a profile changes the ' +
      'environment inside the shell, which is the shell doing it, not the editor. What a custom ' +
      'terminal PROFILE would add (terminal.integrated.profiles.windows -> env) is not captured here.',
  };

  const opened = vscode.window.onDidOpenTerminal(() => { report.didOpenTerminalFire = true; });

  // The editor's own terminal, created through the API the product uses today.
  const terminal = vscode.window.createTerminal({
    name: 'spike env dump',
    shellPath: useNode ? 'node.exe' : powershell,
    shellArgs: useNode
      ? [nodeScript, 'editor-terminal']
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'editor-terminal'],
  });
  // Shown WITHOUT preserveFocus on purpose. Measured 2026-08-17: with
  // `preserveFocus` the process never appeared -- `processId` did not resolve in
  // 20 s and neither did a second probe through the default profile -- so the
  // stand stops being polite and takes the focus, because a terminal that is
  // never rendered is never started.
  terminal.show(false);
  const closed = new Promise<void>((resolve) => {
    const subscription = vscode.window.onDidCloseTerminal((which) => {
      if (which === terminal) {
        report.editorTerminalExitCode = which.exitStatus?.code ?? null;
        report.editorTerminalExitReason = which.exitStatus?.reason ?? null;
        subscription.dispose();
        resolve();
      }
    });
    setTimeout(resolve, FILE_WAIT_MS);
  });
  // `processId` resolving at all is the proof that the terminal really started;
  // without it "no dump" cannot tell a shell that never ran from a script that
  // failed, and a measurement that cannot tell those apart is not one.
  report.editorTerminalProcessId = (await Promise.race([
    terminal.processId,
    delay(FILE_WAIT_MS).then(() => undefined),
  ])) ?? null;
  const editorText = await waitForFile(editorFile, FILE_WAIT_MS);
  await closed;
  terminal.dispose();
  if (editorText === null) {
    report.editorTerminalError = `no dump within ${String(FILE_WAIT_MS)} ms`;
  }

  // Probe two: the editor's own default profile, driven by typing into it. It
  // carries the shell's profile with it -- which is a contaminant for the strict
  // question and the truth for the owner's, since the agent runs in exactly such
  // a terminal today.
  let defaultText: string | null = null;
  if (editorText === null) {
    const defaultFile = path.join(resultsDir, 'env-editor-default.json');
    if (fs.existsSync(defaultFile)) {
      fs.rmSync(defaultFile);
    }
    const second = vscode.window.createTerminal({ name: 'spike env dump (default profile)' });
    second.show(false);
    // Neither path holds a space, so the same line is valid in cmd, PowerShell
    // and pwsh alike; quoting it would not be.
    second.sendText(`${powershell} -NoProfile -ExecutionPolicy Bypass -File ${script} editor-default`, true);
    report.defaultProfileProcessId = (await Promise.race([
      second.processId,
      delay(FILE_WAIT_MS).then(() => undefined),
    ])) ?? null;
    defaultText = await waitForFile(defaultFile, FILE_WAIT_MS);
    second.dispose();
    if (defaultText === null) {
      report.defaultProfileError = `no dump within ${String(FILE_WAIT_MS)} ms`;
    }
  }

  // The same script under our own pty, with the environment our engine would give.
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => { if (!settled) { settled = true; resolve(); } };
    try {
      const child = pty.spawn(
        useNode ? 'node.exe' : 'powershell.exe',
        useNode
          ? [nodeScript, 'our-pty']
          : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'our-pty'],
        {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
          cwd: process.cwd(),
          env: { ...process.env } as Record<string, string>,
        },
      );
      child.onExit(() => { finish(); });
    } catch (error) {
      report.ourPtyError = `spawn threw: ${error instanceof Error ? error.message : String(error)}`;
      finish();
    }
    setTimeout(finish, FILE_WAIT_MS);
  });
  const ptyText = await waitForFile(ptyFile, 2000);
  if (ptyText === null && report.ourPtyError === null) {
    report.ourPtyError = `no dump within ${String(FILE_WAIT_MS)} ms`;
  }

  const hostEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      hostEnv[key] = value;
    }
  }

  opened.dispose();
  const editorDump = editorText ?? defaultText;
  if (editorDump !== null) {
    const editorEnv = JSON.parse(editorDump) as Record<string, string>;
    report.editorTerminalKeyCount = Object.keys(editorEnv).length;
    report.hostVsEditorTerminal = diffEnv('extension host process.env', hostEnv, 'editor terminal', editorEnv);
    if (ptyText !== null) {
      const ourEnv = JSON.parse(ptyText) as Record<string, string>;
      report.ourPtyKeyCount = Object.keys(ourEnv).length;
      report.editorTerminalVsOurPty = diffEnv('editor terminal', editorEnv, 'our pty', ourEnv);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// (10) a single write of 64 KiB, hashed at the far end
// ---------------------------------------------------------------------------

export interface WritePayloadResult {
  readonly name: string;
  sentChars: number;
  sentBytes: number;
  sentSha: string;
  gotChars: number | null;
  gotBytes: number | null;
  gotSha: string | null;
  identical: boolean;
  msToAnswer: number | null;
  /** Bytes that came back while the payload was in flight: raw mode should silence the echo. */
  bytesEchoedBack: number;
  error: string | null;
}

export interface LargeWriteReport {
  runner: string | null;
  ready: boolean;
  payloads: WritePayloadResult[];
  error: string | null;
}

function asciiPayload(chars: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';
  let out = '';
  let index = 0;
  while (out.length < chars) {
    out += alphabet[index % alphabet.length];
    index += 1;
  }
  return out.slice(0, chars);
}

function mixedPayload(atLeastChars: number): string {
  // Repeated whole units so a surrogate pair is never cut in half.
  const unit = 'абв-XY-\u{1F642}-';
  let out = '';
  while (out.length < atLeastChars) {
    out += unit;
  }
  return out;
}

async function measureLargeWrite(pty: typeof NodePty, context: vscode.ExtensionContext): Promise<LargeWriteReport> {
  const script = path.join(context.extensionPath, 'scripts', 'echo-check.js');
  const report: LargeWriteReport = { runner: null, ready: false, payloads: [], error: null };

  const attempts: Array<{ label: string; file: string; args: string[]; env: Record<string, string> }> = [
    { label: 'node.exe on PATH', file: 'node.exe', args: [script], env: { ...process.env } as Record<string, string> },
    {
      label: 'the editor binary as node (ELECTRON_RUN_AS_NODE)',
      file: process.execPath,
      args: [script],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>,
    },
  ];

  for (const attempt of attempts) {
    let child: NodePty.IPty;
    try {
      child = pty.spawn(attempt.file, attempt.args, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: context.extensionPath,
        env: attempt.env,
      });
    } catch (error) {
      report.error = `${attempt.label}: spawn threw: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    let seen = '';
    let bytesSinceMark = 0;
    child.onData((data) => {
      seen += data;
      bytesSinceMark += data.length;
      // Keep the tail only: an echo that is not suppressed would otherwise put
      // megabytes in memory, and the answer always arrives at the end.
      if (seen.length > 200000) {
        seen = seen.slice(-4000);
      }
    });

    const waitFor = async (pattern: RegExp, ceilingMs: number): Promise<RegExpExecArray | null> => {
      const startedAt = Date.now();
      for (;;) {
        const match = pattern.exec(seen);
        if (match !== null) {
          return match;
        }
        if (Date.now() - startedAt >= ceilingMs) {
          return null;
        }
        await delay(25);
      }
    };

    const ready = await waitFor(/READY/u, 20000);
    if (ready === null) {
      report.error = `${attempt.label}: no READY within 20000 ms`;
      child.kill();
      continue;
    }

    report.runner = attempt.label;
    report.ready = true;

    const payloads: Array<{ name: string; text: string }> = [
      { name: 'ascii-64KiB', text: asciiPayload(65536) },
      { name: 'mixed-8K-chars (cyrillic + emoji)', text: mixedPayload(8192) },
    ];

    for (const payload of payloads) {
      seen = '';
      bytesSinceMark = 0;
      const result: WritePayloadResult = {
        name: payload.name,
        sentChars: payload.text.length,
        sentBytes: Buffer.byteLength(payload.text, 'utf8'),
        sentSha: crypto.createHash('sha256').update(payload.text, 'utf8').digest('hex'),
        gotChars: null,
        gotBytes: null,
        gotSha: null,
        identical: false,
        msToAnswer: null,
        bytesEchoedBack: 0,
        error: null,
      };
      const startedAt = Date.now();
      // One call. Whether node-pty, the pipe or ConPTY splits it is their business.
      child.write(`${payload.text}\r`);
      const answer = await waitFor(/ECHOCHECK chars=(\d+) bytes=(\d+) sha=([0-9a-f]+) END/u, 40000);
      if (answer === null) {
        result.error = 'no ECHOCHECK line within 40000 ms';
      } else {
        result.msToAnswer = Date.now() - startedAt;
        result.gotChars = Number(answer[1]);
        result.gotBytes = Number(answer[2]);
        result.gotSha = answer[3] ?? null;
        result.identical = result.gotSha === result.sentSha;
      }
      result.bytesEchoedBack = bytesSinceMark;
      report.payloads.push(result);
    }

    child.kill();
    return report;
  }

  return report;
}

// ---------------------------------------------------------------------------
// (2) a live `claude`: first word, and which modes it turns on
// ---------------------------------------------------------------------------

/** Modes M3.6 and M3.7 have to render, and M3.8 must not break. */
const MODES: Array<{ sequence: string; what: string }> = [
  { sequence: '\u001b[?2004h', what: 'bracketed paste' },
  { sequence: '\u001b[?2026h', what: 'synchronized output' },
  { sequence: '\u001b[?1004h', what: 'focus reporting' },
  { sequence: '\u001b[?9001h', what: 'win32 input mode' },
  { sequence: '\u001b[?2031h', what: 'theme change notifications' },
  { sequence: '\u001b[?1049h', what: 'alternate screen buffer' },
  { sequence: '\u001b[?1000h', what: 'mouse tracking' },
  { sequence: '\u001b[?1006h', what: 'SGR mouse encoding' },
];

export interface LiveClaudeReport {
  cwd: string;
  spawned: boolean;
  reportedPid: number | null;
  firstDataMs: number | null;
  bytesIn4s: number;
  modesTurnedOn: string[];
  tree: ProcessRow[] | string | null;
  head: string;
  exitCodeOnKill: number | null;
  signalOnKill: number | null;
  msUntilPidGone: number | null;
  error: string | null;
}

async function measureLiveClaude(pty: typeof NodePty, cwd: string): Promise<LiveClaudeReport> {
  const report: LiveClaudeReport = {
    cwd,
    spawned: false,
    reportedPid: null,
    firstDataMs: null,
    bytesIn4s: 0,
    modesTurnedOn: [],
    tree: null,
    head: '',
    exitCodeOnKill: null,
    signalOnKill: null,
    msUntilPidGone: null,
    error: null,
  };

  let child: NodePty.IPty;
  const startedAt = Date.now();
  try {
    child = pty.spawn('claude.exe', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
  } catch (error) {
    report.error = `spawn threw: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  report.spawned = true;
  report.reportedPid = child.pid;

  let all = '';
  child.onData((data) => {
    report.firstDataMs ??= Date.now() - startedAt;
    report.bytesIn4s += data.length;
    if (all.length < 400000) {
      all += data;
    }
    if (report.head.length < 1500) {
      report.head = (report.head + data).slice(0, 1500);
    }
  });

  const exited = new Promise<ExitEvent | null>((resolve) => {
    child.onExit(resolve);
  });

  await delay(CLAUDE_SETTLE_MS);

  for (const mode of MODES) {
    if (all.includes(mode.sequence)) {
      report.modesTurnedOn.push(`${mode.sequence.replace('\u001b', 'ESC')} — ${mode.what}`);
    }
  }
  report.tree = await processTree(child.pid);

  child.kill();
  const outcome = await Promise.race([exited, delay(10000).then(() => null)]);
  if (outcome !== null) {
    report.exitCodeOnKill = outcome.exitCode;
    report.signalOnKill = outcome.signal ?? null;
  } else {
    report.error = 'no exit event within 10000 ms after kill()';
  }
  report.msUntilPidGone = await waitUntilGone(child.pid);
  return report;
}

// ---------------------------------------------------------------------------
// (7) does the child survive the death of the extension host
// ---------------------------------------------------------------------------

interface SurvivorChild {
  readonly what: string;
  readonly pid: number;
  readonly treeWhenArmed: ProcessRow[] | string;
  aliveJustBeforeReload: boolean | null;
}

interface SurvivorState {
  readonly armedAt: string;
  readonly cwd: string;
  readonly children: SurvivorChild[];
}

export interface SurvivalOutcome {
  readonly what: string;
  readonly pid: number;
  /**
   * Alive at the last instant this host was still running. Without it, "dead
   * afterwards" would not distinguish the host's death from the child having
   * quit on its own while we were not looking.
   */
  aliveJustBeforeReload: boolean | null;
  aliveAfterHostDeath: boolean;
  treeWhenArmed: ProcessRow[] | string;
  treeAfterHostDeath: ProcessRow[] | string | null;
  /** Killing by the recorded pid with no IPty in hand -- the M3.5 mechanism. */
  killedByRecordedPid: boolean;
  msUntilPidGone: number | null;
  killError: string | null;
}

export interface SurvivalReport {
  armedAt: string;
  checkedAt: string;
  children: SurvivalOutcome[];
}

function survivorFile(resultsDir: string): string {
  return path.join(resultsDir, 'survivor.json');
}

/**
 * Two children, on purpose.
 *
 * `claude` is the subject, but `claude` can decide to exit -- and then "dead
 * after the reload" would prove nothing. A PowerShell asleep for 900 seconds
 * cannot decide anything, so the pair separates "the host's death killed it"
 * from "it ended by itself".
 */
export async function armSurvivor(
  pty: typeof NodePty,
  resultsDir: string,
  cwd: string,
  log: vscode.OutputChannel,
): Promise<number[]> {
  const wanted: Array<{ what: string; file: string; args: string[] }> = [
    { what: 'claude', file: 'claude.exe', args: [] },
    {
      what: 'powershell asleep for 900 s (a process that cannot exit on its own)',
      file: 'powershell.exe',
      args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 900'],
    },
  ];

  const children: SurvivorChild[] = [];
  for (const item of wanted) {
    try {
      const child = pty.spawn(item.file, item.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd,
        env: { ...process.env } as Record<string, string>,
      });
      // Drained on purpose: a full conpty buffer would stall the child and we
      // would be measuring our own neglect.
      child.onData(() => { /* drained */ });
      children.push({ what: item.what, pid: child.pid, treeWhenArmed: [], aliveJustBeforeReload: null });
    } catch (error) {
      log.appendLine(`survivor: ${item.what} spawn threw: ${String(error)}`);
    }
  }
  await delay(3000);
  for (const child of children) {
    (child as { treeWhenArmed: ProcessRow[] | string }).treeWhenArmed = await processTree(child.pid);
  }

  const state: SurvivorState = { armedAt: new Date().toISOString(), cwd, children };
  fs.writeFileSync(survivorFile(resultsDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  log.appendLine(`survivor armed: ${children.map((c) => String(c.pid)).join(', ')}`);
  return children.map((c) => c.pid);
}

/** Last look before we kill this host, so the answer cannot be misread. */
export function stampBeforeReload(resultsDir: string): void {
  const file = survivorFile(resultsDir);
  if (!fs.existsSync(file)) {
    return;
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SurvivorState;
  for (const child of state.children) {
    child.aliveJustBeforeReload = isAlive(child.pid);
  }
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function checkSurvivor(resultsDir: string, log: vscode.OutputChannel): Promise<SurvivalReport | null> {
  const file = survivorFile(resultsDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SurvivorState;
  fs.rmSync(file);

  const report: SurvivalReport = { armedAt: state.armedAt, checkedAt: new Date().toISOString(), children: [] };
  for (const child of state.children) {
    const outcome: SurvivalOutcome = {
      what: child.what,
      pid: child.pid,
      aliveJustBeforeReload: child.aliveJustBeforeReload,
      aliveAfterHostDeath: isAlive(child.pid),
      treeWhenArmed: child.treeWhenArmed,
      treeAfterHostDeath: null,
      killedByRecordedPid: false,
      msUntilPidGone: null,
      killError: null,
    };
    log.appendLine(`survivor check: ${child.what} pid ${String(child.pid)} alive=${String(outcome.aliveAfterHostDeath)}`);

    if (outcome.aliveAfterHostDeath) {
      outcome.treeAfterHostDeath = await processTree(child.pid);
      // No IPty in hand: the object died with the host. This is the M3.5 move.
      try {
        process.kill(child.pid, 'SIGKILL');
        outcome.killedByRecordedPid = true;
      } catch (error) {
        outcome.killError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      outcome.msUntilPidGone = await waitUntilGone(child.pid);
    }
    report.children.push(outcome);
  }
  return report;
}

// ---------------------------------------------------------------------------
// the whole of stage B
// ---------------------------------------------------------------------------

export interface StageBReport {
  kills: KillReport[];
  descendantKill: DescendantKillReport | null;
  environment: EnvReport | null;
  largeWrite: LargeWriteReport | null;
  liveClaude: LiveClaudeReport | null;
  survival: SurvivalReport | null;
  notMeasuredHere: string[];
}

export async function runStageB(
  pty: typeof NodePty,
  context: vscode.ExtensionContext,
  resultsDir: string,
  cwd: string,
  log: vscode.OutputChannel,
): Promise<StageBReport> {
  const report: StageBReport = {
    kills: [],
    descendantKill: null,
    environment: null,
    largeWrite: null,
    liveClaude: null,
    survival: null,
    notMeasuredHere: [
      '(3) extension -> webview channel and the back-pressure threshold — stage B, screen half',
      '(4) TUI fidelity, wide glyphs and emoji — stage B, screen half',
      '(5) resize under a stream of output — stage B, screen half',
    ],
  };

  log.appendLine('stage B: kill verdict');
  report.kills.push(
    await measureKill(pty, 'powershell sleeping', 'powershell.exe', [
      '-NoProfile',
      '-Command',
      'Write-Output alive; Start-Sleep -Seconds 300',
    ]),
  );

  log.appendLine('stage B: descendant kill (O4)');
  report.descendantKill = await measureDescendantKill(pty);

  log.appendLine('stage B: environments');
  report.environment = await measureEnvironments(pty, context, resultsDir);

  log.appendLine('stage B: 64 KiB write');
  report.largeWrite = await measureLargeWrite(pty, context);

  log.appendLine('stage B: live claude');
  report.liveClaude = await measureLiveClaude(pty, cwd);

  return report;
}
