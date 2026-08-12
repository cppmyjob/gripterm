import * as vscode from 'vscode';
import { presentTerminal } from '@gripterm/core';
import { terminalUri } from './terminal-decorations';
import type { Disposable, Reconciler, SessionRegistry, TerminalEntry } from '@gripterm/core';

export const TERMINALS_VIEW_ID = 'gripterm.terminals';

/**
 * The list, drawn from the registry.
 *
 * Everything decided here is decided in `presentTerminal`, on the other side of
 * a port, because this package is outside the coverage thresholds (§3.5): what
 * remains below is `new vscode.ThemeIcon(...)` and the event plumbing.
 *
 * Two details that are not plumbing:
 *
 *   * `item.id` is the terminal id, so the editor keeps the person's selection
 *     and scroll position across a redraw. Without it, every hook event would
 *     silently deselect the row someone was reading.
 *   * the tooltip is a plain string, NOT a `MarkdownString`. The lines carry
 *     text we did not write -- the agent's last message, a task, a path -- and
 *     markdown there is at best mangled underscores and at worst a link
 *     somebody clicks.
 */
export class TerminalTreeDataProvider implements vscode.TreeDataProvider<TerminalEntry>, Disposable {
  public readonly onDidChangeTreeData: vscode.Event<void>;

  private readonly _registry: SessionRegistry;
  private readonly _reconciler: Reconciler | null;
  private readonly _changed = new vscode.EventEmitter<void>();
  private readonly _subscriptions: readonly Disposable[];

  /**
   * The reconciler is optional because a window with no shared base has no
   * other windows to be right or wrong about: every record it holds is its own
   * and live, which is exactly what `presentTerminal` assumes without one.
   */
  constructor(registry: SessionRegistry, reconciler: Reconciler | null = null) {
    this._registry = registry;
    this._reconciler = reconciler;
    this.onDidChangeTreeData = this._changed.event;
    // No delta: the signal says "read again". A tree that trusted a delta would
    // silently miss whatever a lost batch contained (M2.5).
    const redraw = (): void => {
      this._changed.fire();
    };
    this._subscriptions = [
      registry.subscribe(redraw),
      // Liveness lives nowhere in the records, so nothing in the registry moves
      // when a window dies -- and without this the rows of a window that closed
      // would go on claiming it is there until something else happened to
      // change (§4.3, M2.12).
      ...(reconciler === null ? [] : [reconciler.subscribe(redraw)]),
    ];
  }

  public getTreeItem(entry: TerminalEntry): vscode.TreeItem {
    // `knows` is what tells our records from the ones the base projected in, and
    // it decides which buttons the row offers -- see `CONTEXT_FOREIGN`.
    const shown = presentTerminal(entry, {
      ours: this._registry.knows(entry.terminalId),
      // `detached` is laid over the row here and written nowhere (§4.3). With
      // no reconciler there is only this window, which is live by being the one
      // asking.
      liveness: this._reconciler?.livenessOf(entry.owner.ownerId) ?? 'live',
    });
    const item = new vscode.TreeItem(shown.label);
    item.id = entry.terminalId.value;
    // Names no file and is never opened. It exists so that the person's own
    // colour has something to attach to: a decoration is the only way the
    // platform offers to colour a row's label, and the icon's colour is spoken
    // for by the state (M2.7). The label above is given explicitly, so the uri
    // does not become the row's name.
    item.resourceUri = terminalUri(entry.terminalId);
    item.description = shown.description;
    item.tooltip = shown.tooltipLines.join('\n');
    item.contextValue = shown.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      shown.iconId,
      shown.colorId === null ? undefined : new vscode.ThemeColor(shown.colorId)
    );
    return item;
  }

  /**
   * Flat, and in the order terminals were created.
   *
   * Sorting by "how much this one needs you" was considered and dropped: a list
   * that reorders itself while being read is a list you click the wrong row in,
   * and the state is already on every row.
   */
  public getChildren(element?: TerminalEntry): TerminalEntry[] {
    return element === undefined ? [...this._registry.list()] : [];
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._changed.dispose();
  }
}
