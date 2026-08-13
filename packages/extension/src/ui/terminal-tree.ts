import * as vscode from 'vscode';
import { groupTerminals, presentTerminal } from '@gripterm/core';
import { terminalUri } from './terminal-decorations';
import type {
  Disposable,
  Reconciler,
  SessionRegistry,
  TerminalEntry,
  TerminalGroup,
  TerminalId,
} from '@gripterm/core';

export const TERMINALS_VIEW_ID = 'gripterm.terminals';

/** What a `when` clause on a heading would test. Nothing is offered on one yet. */
export const CONTEXT_PROJECT = 'gripterm.project';

/**
 * A row of the list: a project heading, or a terminal under one.
 *
 * A union rather than two views, because the platform's tree is one tree and
 * `reveal` walks it through `getParent`. The `groupKey` is carried on the
 * terminal rather than looked up later so that a node handed back to us by the
 * editor still knows where it lives.
 */
export type TerminalTreeNode =
  | { readonly kind: 'project', readonly group: TerminalGroup }
  | { readonly kind: 'terminal', readonly entry: TerminalEntry, readonly groupKey: string };

export interface TerminalTreeOptions {
  readonly registry: SessionRegistry;
  /**
   * The sweep, or `null` in a window with no shared base: a window reading
   * nothing has no other windows to be right or wrong about, and every record it
   * holds is its own and live -- which is what `presentTerminal` assumes without
   * one.
   */
  readonly reconciler: Reconciler | null;
  /** The folders THIS window has open, which is what puts its own project first. */
  readonly windowFolders: readonly string[];
}

/**
 * The list, drawn from the registry and grouped by project (П4).
 *
 * Everything decided here is decided in `presentTerminal` and `groupTerminals`,
 * on the other side of a port, because this package is outside the coverage
 * thresholds (§3.5): what remains below is `new vscode.ThemeIcon(...)` and the
 * event plumbing.
 *
 * **Why there are headings at all.** Visibility is machine-global (§0): every
 * window shows every terminal on the machine. Without a heading that is one flat
 * list whose rows differ only in which window will answer for them -- and the
 * rows a window may act on are a subset a person cannot see. The heading is what
 * makes the read-only ones legible as belonging somewhere else.
 *
 * Three details that are not plumbing:
 *
 *   * `item.id` is the terminal id, so the editor keeps the person's selection
 *     and scroll position across a redraw. Without it, every hook event would
 *     silently deselect the row someone was reading. Headings are keyed on the
 *     folder for the same reason, and it is also what makes a group a person
 *     collapsed stay collapsed.
 *   * the tooltip is a plain string, NOT a `MarkdownString`. The lines carry
 *     text we did not write -- the agent's last message, a task, a path -- and
 *     markdown there is at best mangled underscores and at worst a link
 *     somebody clicks.
 *   * `getParent` is required by the platform for `reveal`, and its breach is
 *     quiet: the list opens and the row is simply not selected (M2.13).
 */
export class TerminalTreeDataProvider
implements vscode.TreeDataProvider<TerminalTreeNode>, Disposable {
  public readonly onDidChangeTreeData: vscode.Event<void>;

  private readonly _options: TerminalTreeOptions;
  private readonly _changed = new vscode.EventEmitter<void>();
  private readonly _subscriptions: readonly Disposable[];

  constructor(options: TerminalTreeOptions) {
    this._options = options;
    this.onDidChangeTreeData = this._changed.event;
    // No delta: the signal says "read again". A tree that trusted a delta would
    // silently miss whatever a lost batch contained (M2.5).
    const redraw = (): void => {
      this._changed.fire();
    };
    this._subscriptions = [
      options.registry.subscribe(redraw),
      // Liveness lives nowhere in the records, so nothing in the registry moves
      // when a window dies -- and without this the rows of a window that closed
      // would go on claiming it is there until something else happened to
      // change (§4.3, M2.12).
      ...(options.reconciler === null ? [] : [options.reconciler.subscribe(redraw)]),
    ];
  }

  public getTreeItem(node: TerminalTreeNode): vscode.TreeItem {
    return node.kind === 'project' ? projectItem(node.group) : this._terminalItem(node.entry);
  }

  public getChildren(node?: TerminalTreeNode): TerminalTreeNode[] {
    if (node === undefined) {
      return this._groups().map((group) => ({ kind: 'project', group }));
    }
    if (node.kind === 'terminal') {
      return [];
    }
    return node.group.entries.map((entry) => ({
      kind: 'terminal',
      entry,
      groupKey: node.group.key,
    }));
  }

  /**
   * The heading a row sits under, rebuilt rather than remembered.
   *
   * The editor identifies nodes by the `id` on their tree item, so a heading
   * built here matches the one `getChildren` produced. Remembering them instead
   * would mean a `reveal` that arrives before the first draw -- which is exactly
   * when a notification's button fires -- had nothing to walk.
   */
  public getParent(node: TerminalTreeNode): TerminalTreeNode | undefined {
    if (node.kind === 'project') {
      return undefined;
    }
    const group = this._groups().find((one) => one.key === node.groupKey);
    return group === undefined ? undefined : { kind: 'project', group };
  }

  /** The node for a terminal id, for the commands that select a row (M2.13). */
  public nodeFor(terminalId: TerminalId): TerminalTreeNode | null {
    for (const group of this._groups()) {
      const entry = group.entries.find((one) => one.terminalId.equals(terminalId));
      if (entry !== undefined) {
        return { kind: 'terminal', entry, groupKey: group.key };
      }
    }
    return null;
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._changed.dispose();
  }

  private _groups(): readonly TerminalGroup[] {
    return groupTerminals(this._options.registry.list(), this._options.windowFolders);
  }

  private _terminalItem(entry: TerminalEntry): vscode.TreeItem {
    // `knows` is what tells our records from the ones the base projected in, and
    // it decides which buttons the row offers -- see `CONTEXT_FOREIGN`.
    const shown = presentTerminal(entry, {
      ours: this._options.registry.knows(entry.terminalId),
      // The owner's liveness is laid over the row here and written nowhere
      // (§4.3). With no reconciler there is only this window, which is live by
      // being the one asking.
      liveness: this._options.reconciler?.livenessOf(entry.owner.ownerId) ?? 'live',
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
}

/**
 * One project heading.
 *
 * Expanded to begin with: a list whose rows are all behind a chevron answers
 * nothing at a glance, which is what П1 is about. Collapsing is the person's,
 * and the id above is what makes it stick.
 */
function projectItem(group: TerminalGroup): vscode.TreeItem {
  const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `project:${group.key}`;
  item.description = group.detail;
  item.tooltip = group.folder ?? 'Terminals of a window with no folder open';
  item.contextValue = CONTEXT_PROJECT;
  // A folder open HERE is drawn as a workspace root, the way the editor draws
  // its own; anything else is somebody else's project, and the difference is
  // what tells a person which rows they can act on before they hover one.
  item.iconPath = new vscode.ThemeIcon(group.mine ? 'root-folder' : 'folder');
  return item;
}
