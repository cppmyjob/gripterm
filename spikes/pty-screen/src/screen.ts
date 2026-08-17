/**
 * M3.2 stage B, the screen half: xterm in a webview view, instrumented.
 *
 * Three of the ten answers live here:
 *   (3) the extension -> webview channel and where back-pressure has to start.
 *       The number M3.7 needs is not "how big is a chunk" but "how far behind
 *       does the consumer fall", so every chunk is posted with a sequence number
 *       and xterm's own write callback is the acknowledgement. Measured twice:
 *       raw, one message per `onData`, and coalesced on a timer, so the cost of
 *       the message boundary is separated from the cost of the parse.
 *   (4) whether the unicode11 addon changes anything -- two off-screen twins on
 *       Unicode 6 and Unicode 11 get the same fixture and report where the
 *       cursor landed. This is the claim M3.6 makes, and it has never been
 *       checked on the glyphs Claude Code actually prints.
 *   (5) a resize under a live stream, which is the case xterm.js#1914 and
 *       vscode#247385 are about. The producer numbers its lines; afterwards the
 *       buffer is scanned for gaps and duplicates.
 *
 * The view is a panel view because that is where the product's terminal goes,
 * and because a panel view does not exist until its tab is shown -- which is
 * the M3.7 lesson, and the reason the stand focuses the view itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type * as NodePty from 'node-pty';

export const VIEW_ID = 'spikePtyScreen.screen';

const READY_TIMEOUT_MS = 20000;
const DRAIN_TIMEOUT_MS = 120000;
const CHANNEL_COLS = 120;
const CHANNEL_ROWS = 30;

/**
 * Everything Claude Code puts on a screen that a naive terminal gets wrong.
 *
 * Box drawing and SGR are the frame; `\r` without `\n` is the spinner; the wide
 * glyphs are the ones the CLI prints on every tool call, and they are the whole
 * reason M3.6 insists on the unicode11 addon.
 */
const FIXTURE = [
  '\u001b[38;2;255;193;7m┌──────────────┐\u001b[0m\r\n',
  '\u001b[38;2;255;193;7m│\u001b[0m frame \u001b[1mbold\u001b[22m \u001b[38;2;100;200;255mcolor\u001b[0m \u001b[38;2;255;193;7m│\u001b[0m\r\n',
  '\u001b[38;2;255;193;7m└──────────────┘\u001b[0m\r\n',
  'wide: ⏺ ✅ 🙂 中文 ｦｱ\r\n',
  'combining: é ä क्ष\r\n',
  'spinner: ⠋\rspinner: ⠙\rspinner: ⠹\r\n',
  'tail',
].join('');

interface Pending {
  readonly test: (message: Record<string, unknown>) => boolean;
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ChannelRun {
  readonly mode: string;
  chunksFromPty: number;
  messagesPosted: number;
  charsSent: number;
  charsAcked: number;
  /** Wall clock from spawn to the producer's exit. */
  producerMs: number | null;
  /** Wall clock from spawn to the last acknowledgement. */
  drainMs: number | null;
  maxBacklogChars: number | null;
  maxAckLatencyMs: number | null;
  meanAckLatencyMs: number | null;
  drained: boolean;
}

export interface ResizeRun {
  resizes: Array<{ atMs: number; cols: number; rows: number }>;
  linesPrinted: number;
  tokensFound: number | null;
  distinct: number | null;
  lowest: number | null;
  highest: number | null;
  duplicated: number | null;
  gaps: number | null;
  /** Which numbers vanished, so a gap is a fact rather than a count. */
  missing: unknown;
  finalCols: number | null;
  finalRows: number | null;
  resizeErrors: string[];
  /** What the extension itself counted in the raw stream, before the webview. */
  distinctOnTheWire: number | null;
  /** What the webview counted in the chunks it received, before xterm parsed them. */
  distinctReceivedByWebview: number | null;
  error: string | null;
}

export interface TwinRun {
  identical: boolean | null;
  unicode6: unknown;
  unicode11: unknown;
  error: string | null;
}

export interface ScreenReport {
  viewResolved: boolean;
  resolveCount: number;
  firstFit: { cols: number | null; rows: number | null; error: string | null } | null;
  twins: TwinRun | null;
  channel: ChannelRun[];
  resizeUnderStream: ResizeRun | null;
  error: string | null;
}

export class ScreenBoard implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private readonly pendings = new Set<Pending>();
  private readonly ready: Promise<void>;
  private markReady: () => void = () => { /* replaced in the constructor */ };
  public resolveCount = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.resolveCount += 1;
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      if (message['t'] === 'ready') {
        this.markReady();
      }
      for (const pending of Array.from(this.pendings)) {
        if (pending.test(message)) {
          clearTimeout(pending.timer);
          this.pendings.delete(pending);
          pending.resolve(message);
        }
      }
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const base = webview.asWebviewUri(media).toString();
    const template = fs.readFileSync(path.join(media.fsPath, 'screen.html'), 'utf8');
    return template
      .replaceAll('__CSP_SOURCE__', webview.cspSource)
      .replaceAll('__NONCE__', nonce)
      .replaceAll('__VENDOR__', `${base}/vendor`)
      .replaceAll('__MEDIA__', base);
  }

  public post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  public waitFor(test: (message: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        test,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendings.delete(pending);
          reject(new Error(`no answer within ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.pendings.add(pending);
    });
  }

  /** A standing listener for one message type. Never resolves; it observes. */
  public tap(type: string, handler: (message: Record<string, unknown>) => void): vscode.Disposable {
    const pending: Pending = {
      test: (message) => {
        if (message['t'] === type) {
          handler(message);
        }
        return false;
      },
      resolve: () => { /* a tap is not a wait */ },
      reject: () => { /* a tap is not a wait */ },
      timer: setTimeout(() => { /* cleared immediately below */ }, 0),
    };
    clearTimeout(pending.timer);
    this.pendings.add(pending);
    return new vscode.Disposable(() => { this.pendings.delete(pending); });
  }

  public whenReady(): Promise<void> {
    return this.ready;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

function nodeRunner(context: vscode.ExtensionContext, script: string, args: string[]): {
  file: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    file: 'node.exe',
    args: [path.join(context.extensionPath, 'scripts', script), ...args],
    env: { ...process.env } as Record<string, string>,
  };
}

/**
 * One pass of the channel measurement.
 *
 * `coalesceMs` of 0 means "post every chunk the pty gives us"; anything larger
 * batches until the timer fires. The two together separate the cost of the
 * message boundary from the cost of xterm's parse, which is what M3.7 has to
 * choose between.
 */
async function measureChannel(
  board: ScreenBoard,
  pty: typeof NodePty,
  context: vscode.ExtensionContext,
  mode: string,
  coalesceMs: number,
  lines: number,
): Promise<ChannelRun> {
  const run: ChannelRun = {
    mode,
    chunksFromPty: 0,
    messagesPosted: 0,
    charsSent: 0,
    charsAcked: 0,
    producerMs: null,
    drainMs: null,
    maxBacklogChars: null,
    maxAckLatencyMs: null,
    meanAckLatencyMs: null,
    drained: false,
  };

  // A fixed size, not whatever the panel happens to be: measured 2026-08-17,
  // the identical run drained in 0.8 s at 306 columns and never drained at 40.
  const runId = `${mode}-${String(lines)}`;
  board.post({ t: 'reset', cols: CHANNEL_COLS, rows: CHANNEL_ROWS, runId });
  await board.waitFor((m) => m['t'] === 'reset-done', READY_TIMEOUT_MS);

  let ackCount = 0;
  let ackTotal = 0;
  let ackMax = 0;
  let lastAckAt = 0;
  const tap = board.tap('ack', (message) => {
    // An acknowledgement from the previous run arrives after this one started;
    // counting it gave charsAcked > charsSent on 2026-08-17.
    if (message['runId'] !== runId) {
      return;
    }
    const chars = Number(message['chars']);
    const ms = Number(message['ms']);
    run.charsAcked += chars;
    ackCount += 1;
    ackTotal += ms;
    ackMax = Math.max(ackMax, ms);
    lastAckAt = Date.now();
  });

  const runner = nodeRunner(context, 'producer.js', [String(lines), '90']);
  const startedAt = Date.now();
  const child = pty.spawn(runner.file, runner.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: context.extensionPath,
    env: runner.env,
  });

  let buffer = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let seq = 0;
  const flush = (): void => {
    flushTimer = null;
    if (buffer.length === 0) {
      return;
    }
    seq += 1;
    run.messagesPosted += 1;
    run.charsSent += buffer.length;
    board.post({ t: 'data', seq, chunk: buffer });
    buffer = '';
  };

  child.onData((data) => {
    run.chunksFromPty += 1;
    buffer += data;
    if (coalesceMs === 0) {
      flush();
    } else if (flushTimer === null) {
      flushTimer = setTimeout(flush, coalesceMs);
    }
  });

  await new Promise<void>((resolve) => {
    child.onExit(() => { resolve(); });
    setTimeout(resolve, DRAIN_TIMEOUT_MS);
  });
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
  }
  flush();
  run.producerMs = Date.now() - startedAt;

  // Drained means the acknowledgements caught up with the posts, not that the
  // producer stopped: the whole point is the gap between the two.
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (run.charsAcked < run.charsSent && Date.now() < drainDeadline) {
    await delay(50);
  }
  run.drained = run.charsAcked >= run.charsSent;
  run.drainMs = lastAckAt === 0 ? null : lastAckAt - startedAt;
  run.maxAckLatencyMs = ackCount === 0 ? null : Math.round(ackMax);
  run.meanAckLatencyMs = ackCount === 0 ? null : Math.round((ackTotal / ackCount) * 100) / 100;
  tap.dispose();

  board.post({ t: 'scan' });
  const answer = await board.waitFor((m) => m['t'] === 'scanned', READY_TIMEOUT_MS).catch(() => null);
  if (answer !== null) {
    run.maxBacklogChars = Number(answer['maxBacklog']);
  }
  return run;
}

async function measureResizeUnderStream(
  board: ScreenBoard,
  pty: typeof NodePty,
  context: vscode.ExtensionContext,
  lines: number,
): Promise<ResizeRun> {
  const run: ResizeRun = {
    resizes: [],
    linesPrinted: lines,
    tokensFound: null,
    distinct: null,
    lowest: null,
    highest: null,
    duplicated: null,
    gaps: null,
    missing: null,
    finalCols: null,
    finalRows: null,
    resizeErrors: [],
    distinctOnTheWire: null,
    distinctReceivedByWebview: null,
    error: null,
  };

  board.post({ t: 'reset', cols: CHANNEL_COLS, rows: CHANNEL_ROWS, runId: 'resize' });
  await board.waitFor((m) => m['t'] === 'reset-done', READY_TIMEOUT_MS);

  // Paced so the stream outlives the resizes: 20 batches of 1000 lines with
  // 200 ms between them spans about four seconds, and all five resizes land
  // inside it. Measured 2026-08-17 without the pacing: four of the five threw
  // "Cannot resize a pty that has already exited", so the run measured a resize
  // of a draining screen rather than a resize under a live stream.
  const runner = nodeRunner(context, 'producer.js', [String(lines), '90', '1000', '200']);
  const startedAt = Date.now();
  const child = pty.spawn(runner.file, runner.args, {
    name: 'xterm-256color',
    cols: CHANNEL_COLS,
    rows: CHANNEL_ROWS,
    cwd: context.extensionPath,
    env: runner.env,
  });

  let seq = 0;
  // The same count on the extension side. Without it a missing line cannot be
  // pinned on anyone: it could have been dropped by conpty on the way here, or
  // by xterm on the way to the screen, and those are different defects with
  // different owners.
  const seenNumbers = new Set<number>();
  let carry = '';
  child.onData((data) => {
    seq += 1;
    board.post({ t: 'data', seq, chunk: data });
    const text = carry + data;
    for (const match of text.matchAll(/L(\d{6})/gu)) {
      seenNumbers.add(Number(match[1]));
    }
    carry = text.slice(-8);
  });

  // Resizes DURING the stream, which is the case the plan names: on an idle
  // terminal a resize is uninteresting.
  let stopped = false;
  const resizer = (async (): Promise<void> => {
    const sizes: Array<[number, number]> = [[160, 40], [100, 30], [180, 20], [100, 30], [140, 45]];
    for (const size of sizes) {
      // 600 ms apart, inside a stream that runs for about four seconds.
      await delay(600);
      if (stopped) {
        return;
      }
      const [cols, rows] = size;
      run.resizes.push({ atMs: Date.now() - startedAt, cols, rows });
      try {
        child.resize(cols, rows);
      } catch (error) {
        // A resize that lands after the producer exited is our own race, not a
        // finding; it is recorded separately so it cannot be read as one.
        run.resizeErrors.push(`at ${String(Date.now() - startedAt)} ms: ${error instanceof Error ? error.message : String(error)}`);
      }
      board.post({ t: 'resize', cols, rows });
    }
  })();

  await new Promise<void>((resolve) => {
    child.onExit(() => { resolve(); });
    setTimeout(resolve, DRAIN_TIMEOUT_MS);
  });
  stopped = true;
  await resizer;
  await delay(1500);

  run.distinctOnTheWire = seenNumbers.size;
  board.post({ t: 'scan' });
  const answer = await board.waitFor((m) => m['t'] === 'scanned', READY_TIMEOUT_MS).catch(() => null);
  if (answer === null) {
    run.error = run.error ?? 'no scan answer';
    return run;
  }
  run.distinctReceivedByWebview = (answer['receivedDistinct'] as number | undefined) ?? null;
  const report = answer['report'] as Record<string, number | null>;
  run.tokensFound = report['tokensFound'] ?? null;
  run.distinct = report['distinct'] ?? null;
  run.lowest = report['lowest'] ?? null;
  run.highest = report['highest'] ?? null;
  run.duplicated = report['duplicated'] ?? null;
  run.gaps = report['gaps'] ?? null;
  run.missing = (answer['report'] as Record<string, unknown>)['missing'] ?? null;
  run.finalCols = report['cols'] ?? null;
  run.finalRows = report['rows'] ?? null;
  return run;
}

export async function runScreenHalf(
  board: ScreenBoard,
  pty: typeof NodePty,
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<ScreenReport> {
  const report: ScreenReport = {
    viewResolved: false,
    resolveCount: 0,
    firstFit: null,
    twins: null,
    channel: [],
    resizeUnderStream: null,
    error: null,
  };

  // A panel view does not exist until its tab is shown. That is the M3.7 lesson
  // and it is also why this call is here rather than in the owner's hands.
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  try {
    await Promise.race([
      board.whenReady(),
      delay(READY_TIMEOUT_MS).then(() => { throw new Error(`no ready from the webview within ${String(READY_TIMEOUT_MS)} ms`); }),
    ]);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  }
  report.viewResolved = true;
  report.resolveCount = board.resolveCount;

  board.post({ t: 'reset' });
  await board.waitFor((m) => m['t'] === 'reset-done', READY_TIMEOUT_MS).catch(() => null);
  board.post({ t: 'fit' });
  const fitted = await board.waitFor((m) => m['t'] === 'fitted', READY_TIMEOUT_MS).catch(() => null);
  report.firstFit = fitted === null
    ? { cols: null, rows: null, error: 'no fit answer' }
    : {
        cols: (fitted['cols'] as number | null) ?? null,
        rows: (fitted['rows'] as number | null) ?? null,
        error: (fitted['error'] as string | null) ?? null,
      };

  log.appendLine('screen: unicode twins');
  board.post({ t: 'twins', fixture: FIXTURE });
  const twinned = await board.waitFor((m) => m['t'] === 'twinned', READY_TIMEOUT_MS).catch(() => null);
  report.twins = twinned === null
    ? { identical: null, unicode6: null, unicode11: null, error: 'no twin answer' }
    : (() => {
        const answer = twinned['report'] as Record<string, unknown>;
        return {
          identical: (answer['identical'] as boolean | undefined) ?? null,
          unicode6: answer['unicode6'] ?? null,
          unicode11: answer['unicode11'] ?? null,
          error: null,
        };
      })();

  log.appendLine('screen: channel, raw');
  report.channel.push(await measureChannel(board, pty, context, 'one message per pty chunk', 0, 20000));
  log.appendLine('screen: channel, coalesced 16 ms');
  report.channel.push(await measureChannel(board, pty, context, 'coalesced on a 16 ms timer', 16, 20000));

  log.appendLine('screen: resize under stream');
  report.resizeUnderStream = await measureResizeUnderStream(board, pty, context, 20000);

  return report;
}

/** Leaves a live `claude` on the screen so the owner can look at it. */
export async function showLiveClaude(
  board: ScreenBoard,
  pty: typeof NodePty,
  cwd: string,
): Promise<number | null> {
  board.post({ t: 'reset' });
  await board.waitFor((m) => m['t'] === 'reset-done', READY_TIMEOUT_MS).catch(() => null);
  board.post({ t: 'fit' });
  const fitted = await board.waitFor((m) => m['t'] === 'fitted', READY_TIMEOUT_MS).catch(() => null);

  let child: NodePty.IPty;
  try {
    child = pty.spawn('claude.exe', [], {
      name: 'xterm-256color',
      cols: Number(fitted?.['cols'] ?? 100),
      rows: Number(fitted?.['rows'] ?? 30),
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
  } catch {
    return null;
  }

  let seq = 0;
  child.onData((data) => {
    seq += 1;
    board.post({ t: 'data', seq, chunk: data });
  });
  // The owner has to be able to type into it, or question (4) is a photograph.
  board.tap('input', (message) => { child.write(String(message['data'])); });
  board.post({ t: 'say', text: `live claude, pid ${String(child.pid)} — look at the frame, the spinner and the glyphs` });
  return child.pid;
}
