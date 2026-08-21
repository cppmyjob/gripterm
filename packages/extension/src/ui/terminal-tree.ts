import * as vscode from 'vscode';
import { dropInTree, groupTerminals, presentTerminal } from '@gripterm/core';
import { terminalUri } from './terminal-decorations';
import type {
  Disposable,
  Logger,
  Reconciler,
  SessionRegistry,
  TerminalEntry,
  TerminalGroup,
  TerminalId,
  TreeDropTarget,
} from '@gripterm/core';

export const TERMINALS_VIEW_ID = 'gripterm.terminals';

/**
 * What a row of THIS list is, on the way from a hand to a drop.
 *
 * The platform names a tree drag after the view, in lower case, and both ends
 * of the drag have to agree on the string. Ours carries the terminal id and
 * nothing else: an id is a string, and a string is the only thing that crosses
 * from the bundle the host runs to a suite compiled beside it (M2.21).
 */
const ROW_MIME = 'application/vnd.code.tree.gripterm.terminals';

/** What a `when` clause on a heading would test. Nothing is offered on one yet. */
export const CONTEXT_PROJECT = 'gripterm.project';

/** A heading: one project, with the rows of every window that has it open. */
export interface ProjectNode {
  readonly kind: 'project';
  readonly group: TerminalGroup;
}

/**
 * A row of the list: a project heading, or a terminal record itself.
 *
 * A union rather than two views, because the platform's tree is one tree and
 * `reveal` walks it through `getParent`.
 *
 * **THE ROW IS THE ENTRY, and that is a rule rather than a convenience
 * (M2.21).** Whatever `getChildren` returns here is what the editor hands to a
 * command when somebody uses that row's menu, and every one of those commands
 * asks `terminalTargetOf` what it was given. For two milestones this was a
 * wrapper -- `{ kind: 'terminal', entry, groupKey }` -- which is not a terminal
 * anything recognises, so every menu entry on every row quietly fell through to
 * a picker asking which terminal the person meant. Nothing here may wrap an
 * entry again without teaching that function about it in the same commit.
 *
 * The heading a row belongs under is looked up rather than carried on the row
 * for the same reason: a copy of `group.key` on the node is a second place where
 * the answer lives, and a record whose window changed folder would then be
 * revealed under a heading it is no longer in.
 */
export type TerminalTreeNode = TerminalEntry | ProjectNode;

/**
 * Which of the two a node is -- asked of what it HAS, never of which class it is.
 *
 * `node instanceof TerminalEntry` is the obvious spelling and it is wrong here,
 * which a run said and reading could not (M2.21). The host loads the BUNDLE
 * while the integration suite is compiled beside it: two copies of every class
 * of `@gripterm/core` live in one process, and a record the suite builds is an
 * instance of neither the bundle's class nor any other the bundle can name. The
 * suite hands such records to the registry -- that is how it gets a row drawn at
 * all -- so `instanceof` sent every one of them down the heading branch, where
 * `getTreeItem` read `group.label` off a terminal record and threw inside the
 * platform's draw.
 *
 * The discriminant is the heading's, because the heading is the type this file
 * owns. A record is anything that is not one, which is also what makes a record
 * arriving from anywhere -- the store, another window, a test -- a row.
 */
function isHeading(node: TerminalTreeNode): node is ProjectNode {
  return (node as Partial<ProjectNode>).kind === 'project';
}

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
  /** Where a drag that moved nothing says why. */
  readonly logger: Logger;
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
implements
  vscode.TreeDataProvider<TerminalTreeNode>,
  vscode.TreeDragAndDropController<TerminalTreeNode>,
  Disposable {
  public readonly onDidChangeTreeData: vscode.Event<void>;

  /**
   * What this list offers a drag, and what it accepts from one -- itself, both
   * times.
   *
   * Nothing else is accepted, and that is the whole of it: a file dropped on
   * the list would be a file the editor was about to open, and answering it
   * here is taking something away from the person rather than giving it.
   */
  public readonly dragMimeTypes: readonly string[] = [ROW_MIME];
  public readonly dropMimeTypes: readonly string[] = [ROW_MIME];

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
    return isHeading(node) ? projectItem(node.group) : this._terminalItem(node);
  }

  public getChildren(node?: TerminalTreeNode): TerminalTreeNode[] {
    if (node === undefined) {
      return this._groups().map((group) => ({ kind: 'project', group }));
    }
    return isHeading(node) ? [...node.group.entries] : [];
  }

  /**
   * The heading a row sits under, rebuilt rather than remembered.
   *
   * The editor identifies nodes by the `id` on their tree item, so a heading
   * built here matches the one `getChildren` produced. Remembering them instead
   * would mean a `reveal` that arrives before the first draw -- which is exactly
   * when a notification's button fires -- had nothing to walk.
   *
   * **What this ANSWERS is not pinned by anything, and that is measured rather
   * than assumed (M2.21):** a mutant that never finds the heading -- every row an
   * orphan -- survives the whole suite, `reveal` included. What the host refuses
   * outright is a provider with no `getParent` at all (M2.13), and that is all
   * the suite can hold it to; the answer matters where a headless run cannot go,
   * with the view on screen and the heading collapsed. Written for the reader
   * rather than for a test, then: the row is found by its id, not by a key
   * copied onto it, so a record whose window moved folder is revealed under the
   * heading it is in now.
   */
  /**
   * A person picked a row up (owner, 2026-08-21).
   *
   * One row, or nothing. The view is made without `canSelectMany`, so the
   * platform hands over exactly one -- and the guard is not for that: a drag
   * carrying two ids is a drag whose second one this code would silently drop,
   * which is worse than a drag that does nothing.
   *
   * A heading carries nothing. Projects are not ours to rearrange: their order
   * is this window's own folders first and then the machine's, which is what
   * makes two windows read one list the same way.
   */
  public handleDrag(source: readonly TerminalTreeNode[], transfer: vscode.DataTransfer): void {
    const rows = source.filter((node): node is TerminalEntry => !isHeading(node));
    const only = rows.length === 1 ? rows[0] : undefined;
    if (only === undefined) {
      return;
    }
    transfer.set(ROW_MIME, new vscode.DataTransferItem(only.terminalId.value));
  }

  /**
   * A person let a row go (owner, 2026-08-21: "не реализован drag and drop в
   * tree view где список всех терминалов").
   *
   * Everything decided here is decided in `dropInTree`, on the other side of a
   * port, for the reason par. 3.5 gives. What is left below is reading the
   * transfer and writing the records, and the ONE thing worth reading twice is
   * that nothing is written unless every record the move needs is this
   * window's: a list showing the whole machine (par. 0) is mostly rows this
   * window may not write (par. 4.8).
   *
   * Nothing redraws the list from here either. `amend` publishes, the registry
   * notifies, and this provider is one of its listeners -- the same road a
   * change from anywhere else takes (M2.6).
   */
  public handleDrop(target: TerminalTreeNode | undefined, transfer: vscode.DataTransfer): void {
    const carried: unknown = transfer.get(ROW_MIME)?.value;
    if (typeof carried !== 'string') {
      // Anything else in the workbench, dropped on our list. Not ours to answer.
      return;
    }
    const { registry, logger } = this._options;
    const groups = this._groups();
    const moved = groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.terminalId.value === carried);
    if (moved === undefined) {
      // The row went while the hand was moving -- a window closing under it.
      // Looked up rather than parsed back into an id, because a record that is
      // in the list is the only proof the id was ever one of ours.
      logger.info('a row was dropped after its record had gone', { terminalId: carried });
      return;
    }

    const { changed, refusal } = dropInTree({
      groups,
      moved: moved.terminalId,
      target: targetOf(target),
      owns: (terminalId) => registry.knows(terminalId),
    });
    if (refusal !== null) {
      // Silent on screen and loud in the journal. A refused drop leaves the row
      // where the person can see it did not move, and a toast per clumsy drag
      // would be the noisier half of that. It is removable the day the owner
      // says a refusal was not obvious -- the sentences are already named.
      logger.info('a row was dropped and did not move', { terminalId: carried, refusal });
      return;
    }
    for (const entry of changed) {
      registry.amend(entry);
    }
    logger.info('a row was dragged', {
      terminalId: carried,
      // One for an ordinary move, none when it was let go where it already was,
      // and more only when the arrangement had run out of room (`terminal-order`).
      records: changed.length,
    });
  }

  public getParent(node: TerminalTreeNode): TerminalTreeNode | undefined {
    if (isHeading(node)) {
      return undefined;
    }
    const group = this._groups().find((one) =>
      one.entries.some((held) => held.terminalId.equals(node.terminalId)));
    return group === undefined ? undefined : { kind: 'project', group };
  }

  /** The row for a terminal id, for the commands that select one (M2.13). */
  public nodeFor(terminalId: TerminalId): TerminalEntry | null {
    for (const group of this._groups()) {
      const entry = group.entries.find((one) => one.terminalId.equals(terminalId));
      if (entry !== undefined) {
        return entry;
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

/** What the pointer was over, in the units the rule speaks. */
function targetOf(node: TerminalTreeNode | undefined): TreeDropTarget | null {
  if (node === undefined) {
    return null;
  }
  return isHeading(node)
    ? { kind: 'heading', key: node.group.key }
    : { kind: 'row', terminalId: node.terminalId };
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
