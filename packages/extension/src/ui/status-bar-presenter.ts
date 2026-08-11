import * as vscode from 'vscode';
import { summariseTerminals } from '@gripterm/core';
import { TERMINALS_VIEW_ID } from './terminal-tree';
import type { Disposable, SessionRegistry } from '@gripterm/core';

/** Right-hand side, and far enough left to sit beside the other "state of this window" items. */
const PRIORITY = 100;

/**
 * One line in the status bar, and the only part of this extension that is
 * visible without opening anything.
 *
 * It hides itself when this window is running nothing. That is not politeness:
 * a slot occupied in every window saying zero is what makes people uninstall an
 * extension, and the summariser returns `null` for exactly that case.
 *
 * Clicking it reveals the list. The command is the editor's own
 * `<viewId>.focus`, contributed by the view rather than registered by us --
 * one fewer command to keep in step with the manifest.
 */
export class StatusBarPresenter implements Disposable {
  private readonly _registry: SessionRegistry;
  private readonly _item: vscode.StatusBarItem;
  private readonly _subscription: Disposable;

  constructor(registry: SessionRegistry) {
    this._registry = registry;
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY);
    this._item.command = `${TERMINALS_VIEW_ID}.focus`;
    this._subscription = registry.subscribe(() => {
      this.refresh();
    });
    this.refresh();
  }

  public refresh(): void {
    const summary = summariseTerminals(this._registry.list());
    if (summary === null) {
      this._item.hide();
      return;
    }

    this._item.text = summary.text;
    this._item.tooltip = ['Gripterm', ...summary.tooltipLines].join('\n');
    // The warning background is the platform's own "this needs you" colour, so
    // it matches whatever the person's theme uses for it elsewhere.
    this._item.backgroundColor = summary.alert
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this._item.show();
  }

  public dispose(): void {
    this._subscription.dispose();
    this._item.dispose();
  }
}
