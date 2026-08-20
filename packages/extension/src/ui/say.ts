import * as vscode from 'vscode';
import type { Logger } from '@gripterm/core';

export type Level = 'error' | 'info' | 'warning';

const SHOW: Readonly<Record<Level, (message: string) => Thenable<string | undefined>>> = {
  info: (message) => vscode.window.showInformationMessage(message),
  warning: (message) => vscode.window.showWarningMessage(message),
  error: (message) => vscode.window.showErrorMessage(message),
};

/**
 * Tells the person something, and does not wait to be acknowledged.
 *
 * A notification is a statement, not a question: its promise resolves when
 * somebody dismisses the toast, which is minutes away or never. `await` on one
 * holds the command open for that long -- and a command that never returns is
 * a command the editor thinks is still running.
 *
 * The rejection is caught rather than left to become an unhandled one in the
 * host. It is also the single failure a person cannot report, since the thing
 * that would have told them is what failed.
 */
export function say(level: Level, message: string, logger: Logger): void {
  void Promise.resolve(SHOW[level](message)).then(undefined, (cause: unknown) => {
    logger.error('could not show a message', { level, message, cause });
  });
}

/** How many of the last sentences are kept. Enough for a suite, too few to be a log. */
const KEPT = 50;

/**
 * Says things, and remembers that it said them.
 *
 * A notification cannot be read back through the editor API, and replacing
 * `showInformationMessage` from a suite does not work either. Measured
 * 2026-08-18 (M3.13): the replacement collected NOTHING, and the same assertion
 * through this object passed in the next run -- so the window had been answering
 * all along and the sentence was going to another `vscode` object than the one
 * the suite had replaced. A collector that stays empty cannot tell those two
 * apart, which is the whole reason the seam is ours: everything this window
 * tells a person goes through one object, and that object keeps the last few
 * sentences where a suite can read them.
 *
 * What this does NOT prove is that a toast appeared on somebody's screen. It
 * proves that the composition produced the sentence and handed it to `say`,
 * which is one line over the editor API. The screen belongs to M3.14, which is
 * a person looking.
 */
export class Announcer {
  private readonly _said: string[] = [];

  constructor(private readonly _logger: Logger) {}

  /** What this window has said, oldest first. A copy: a reader cannot edit the record. */
  public get said(): readonly string[] {
    return [...this._said];
  }

  public say(level: Level, message: string): void {
    this._said.push(message);
    if (this._said.length > KEPT) {
      this._said.shift();
    }
    say(level, message, this._logger);
  }
}
