import { describeDetails } from '@gripterm/core';
import type * as vscode from 'vscode';
import type { ErrorDetails, Logger } from '@gripterm/core';

/**
 * The `Logger` port on the editor's log channel.
 *
 * A `LogOutputChannel` rather than a plain `OutputChannel`, and that is the
 * whole reason this adapter is one line longer than it looks: the log channel
 * stamps every line with a level and a time, and the editor lets a person raise
 * or lower the level from the UI without us writing a setting for it. A plain
 * channel would need us to write the word "WARN" into the text ourselves, where
 * nothing could filter on it afterwards.
 *
 * The rendering of `details` lives in the domain (`describeDetails`) rather
 * than here. It is where the defect was: half our call sites log a `cause`, and
 * the naive `JSON.stringify` renders an `Error` as `{}` -- so the sentence
 * explaining a failure disappears on the one path nobody watches. Keeping it in
 * the domain also keeps it under the coverage threshold this package is
 * deliberately outside of (§3.5).
 */
export class VsCodeLogger implements Logger {
  private readonly _channel: vscode.LogOutputChannel;

  constructor(channel: vscode.LogOutputChannel) {
    this._channel = channel;
  }

  public info(message: string, details?: ErrorDetails): void {
    this._channel.info(line(message, details));
  }

  public warn(message: string, details?: ErrorDetails): void {
    this._channel.warn(line(message, details));
  }

  public error(message: string, details?: ErrorDetails): void {
    this._channel.error(line(message, details));
  }
}

/**
 * One line, message first.
 *
 * The context is appended rather than passed as a second argument on purpose:
 * `LogOutputChannel` accepts varargs, but what it does with an object is its
 * business and not ours, and "the details were formatted by someone else's
 * `util.inspect` settings" is not a thing to discover from a support log.
 */
function line(message: string, details: ErrorDetails | undefined): string {
  const rendered = describeDetails(details);
  return rendered === '' ? message : `${message} ${rendered}`;
}
