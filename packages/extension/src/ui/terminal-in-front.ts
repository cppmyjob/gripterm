import * as vscode from 'vscode';
import type { Disposable, Logger } from '@gripterm/core';

/**
 * The context key that says a terminal is the editor in front.
 *
 * Ours, and set from one place. What stood here before was the workbench's own
 * `activeEditor == 'terminalEditor'`, and the customer's report on 2026-08-22
 * is what it cost: in Cursor the button never appeared on the terminal's tab
 * AND the command was not in the palette either -- one `when`, keyed on a
 * string of the platform's, failing in both places at once in a fork that does
 * not answer it. A key we set is a key we can be wrong about out loud.
 */
export const TERMINAL_IN_FRONT_KEY = 'gripterm.terminalInFront';

export interface TerminalInFrontOptions {
  /** Where the answer goes. `setContext` in the composition, a spy in a test. */
  readonly announce: (inFront: boolean) => void;
  readonly logger: Logger;
}

/**
 * Whether the editor the person is looking at is a terminal.
 *
 * Read from `TabInputTerminal`, which is API and not a context key: the tab in
 * front of the active group either is a terminal or is not, and that is a
 * question the editor answers the same way in every build that has the tab API
 * at all.
 *
 * **Not "one of ours", and it cannot be.** A `Tab` carries no uri for a
 * terminal -- `TabInputTerminal` is empty -- so nothing on the tab side can be
 * matched against the terminals this window made. The same limit was there
 * before, in the key this replaces, and the price is the same and no bigger:
 * the button also appears on a terminal the person moved into the editor area
 * themselves, where it does the same sensible thing.
 */
export class TerminalInFront implements Disposable {
  private readonly _options: TerminalInFrontOptions;
  private readonly _subscriptions: readonly vscode.Disposable[];
  /** `null` until the first answer, so the first one is always announced. */
  private _inFront: boolean | null = null;

  constructor(options: TerminalInFrontOptions) {
    this._options = options;
    const look = (): void => {
      this.refresh();
    };
    this._subscriptions = [
      // Both, because they are different events: a tab becoming the active one
      // inside a group is a tab change, and a group becoming the active group
      // is a group change. The button has to follow either.
      vscode.window.tabGroups.onDidChangeTabs(look),
      vscode.window.tabGroups.onDidChangeTabGroups(look),
    ];
    this.refresh();
  }

  /** What was last announced. Read by the live suite, which cannot read a context key. */
  public get inFront(): boolean {
    return this._inFront ?? false;
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
  }

  /** Look again, and say so only when the answer has changed. */
  public refresh(): void {
    const now = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal;
    if (now === this._inFront) {
      return;
    }
    this._inFront = now;
    this._options.announce(now);
    this._options.logger.info('the editor in front is a terminal, or has stopped being one', {
      inFront: now,
    });
  }
}
