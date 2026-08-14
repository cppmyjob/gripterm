import * as vscode from 'vscode';
import { shellQuietVerdict } from '@gripterm/core';
import type { Logger, ShellQuietPolicy } from '@gripterm/core';

/**
 * The waiting, in the numbers a real host answered with on 2026-08-14 (three
 * runs, Windows, the editor's default shell):
 *
 *   another extension typed into a fresh terminal at 20, 23 and 60 ms;
 *   shell integration announced itself at 5215, 5514 and 5728 ms;
 *   their command then STARTED 277, 284 and 423 ms after the announcement.
 *
 * So `graceMs` is the announcement-to-their-command gap with room to spare -- it
 * is also what the end-to-end probe used when the order came out right --
 * `readyMs` is the announcement with a wide margin, and it errs long on purpose:
 * giving up early costs the ordering the person asked for, while giving up late
 * costs only a slower start on a shell that has no integration at all.
 */
const POLICY: ShellQuietPolicy = { graceMs: 1500, readyMs: 15000, patienceMs: 30000 };

/** How often the wait is re-examined. Well under the smallest gap measured. */
const TICK_MS = 100;

/**
 * Holds a line back until the shell it is meant for is the person's own.
 *
 * The problem, in one sentence: an extension that activates an environment types
 * into every terminal that is created, ours included, and a line we send the
 * moment the terminal exists gets there first -- so the agent starts, and their
 * activation is typed into the agent instead of the shell.
 *
 * Nothing here knows or asks WHO else is typing. The rule is the general one:
 * whatever the environment does to a fresh shell happens first, and the agent
 * starts after it. That is also why the wait is bounded -- a shell can be busy
 * forever, and an agent that never starts is a worse answer than one that starts
 * behind somebody's build.
 *
 * `sendText` and never `shellIntegration.executeCommand`: measured twice on
 * 2026-08-14, executing through the integration while another command was in
 * flight left ONE of the two alive -- once theirs, once ours. Plain typing into
 * a busy shell was buffered and ran after it, both alive and in order.
 */
export class VsCodeQuietShell {
  private readonly _logger: Logger;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  /**
   * Types `commandLine` into `terminal` once the shell is listening and quiet.
   *
   * Returns at once; the waiting outlives the call. A terminal closed while the
   * wait is on ends the wait with nothing typed -- a person who shuts a tab
   * during the five seconds a shell takes to come up has said what they want.
   */
  public typeWhenQuiet(terminal: vscode.Terminal, commandLine: string): void {
    const createdAt = Date.now();
    const state = {
      createdAt,
      integrationAt: terminal.shellIntegration === undefined ? null : createdAt,
      inFlight: 0,
      lastEndedAt: null as number | null,
    };

    const subscriptions: vscode.Disposable[] = [];
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };

    subscriptions.push(
      vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
          state.integrationAt ??= Date.now();
        }
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        if (event.terminal === terminal) {
          state.inFlight += 1;
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.terminal === terminal) {
          // Floored, because the editor may report the end of a command that
          // started before we were watching, and a negative count would read as
          // a shell quieter than it is.
          state.inFlight = Math.max(0, state.inFlight - 1);
          state.lastEndedAt = Date.now();
        }
      }),
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          stop();
          this._logger.info('the terminal went before its launch line could be typed', {
            waitedMs: Date.now() - createdAt,
          });
        }
      })
    );

    timer = setInterval(() => {
      const verdict = shellQuietVerdict(state, Date.now(), POLICY);
      if (verdict === 'wait') {
        return;
      }
      stop();
      terminal.sendText(commandLine, true);
      this._logger.info('the launch line was typed into the shell', {
        verdict,
        waitedMs: Date.now() - createdAt,
      });
    }, TICK_MS);
    // Nothing here is worth keeping a process alive for: a window being torn
    // down must not wait out a shell that is never coming up.
    timer.unref();
  }
}
