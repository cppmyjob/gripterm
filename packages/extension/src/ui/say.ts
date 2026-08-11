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
