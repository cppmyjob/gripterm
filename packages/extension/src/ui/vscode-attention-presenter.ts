import * as vscode from 'vscode';
import type { AttentionPresenter, AttentionRequest, Logger } from '@gripterm/core';

/**
 * The notification itself.
 *
 * `showWarningMessage` rather than an information message, and rather than a
 * badge: the whole signal is "a person is being waited on", and the warning
 * level is what the platform holds back until the window has focus again [Ф,
 * round 8: the purge timer checks `hostService.hasFocus`, the toast itself does
 * not]. So the promise is precisely "visible the moment you come back", and it
 * rests on the platform rather than on any code of ours.
 *
 * Nothing is awaited. A notification is answered minutes later or never, and
 * awaiting one would hold this call open for as long as a person is at lunch.
 */
export class VsCodeAttentionPresenter implements AttentionPresenter {
  private readonly _logger: Logger;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  public present(request: AttentionRequest): void {
    const titles = request.actions.map((action) => action.title);

    void Promise.resolve(vscode.window.showWarningMessage(request.message, ...titles)).then(
      async (chosen) => {
        if (chosen === undefined) {
          // Dismissed, or timed out. Both mean the same thing: the person saw
          // it and moved on, and there is nothing to record.
          return;
        }
        const action = request.actions.find((candidate) => candidate.title === chosen);
        if (action === undefined) {
          return;
        }
        await vscode.commands.executeCommand(action.command, ...action.arguments);
      },
      (cause: unknown) => {
        // A failing notification must not become an unhandled rejection in the
        // host. It is also the one failure a person cannot report, since the
        // thing that would have told them is what failed.
        this._logger.error('could not show a notification', {
          terminalId: request.terminalId.value,
          signal: request.signal,
          cause,
        });
      }
    );
  }
}
