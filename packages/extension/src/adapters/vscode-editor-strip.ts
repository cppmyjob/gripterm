import * as vscode from 'vscode';
import { withGroupShare } from '@gripterm/core';
import type { EditorLayout, Logger } from '@gripterm/core';

/**
 * How much of the space it shares our strip asks for when it is made. A third
 * is enough to read a conversation and little enough to leave the code the
 * screen; the four digits are a third to the nearest pixel of any screen that
 * exists, and the editor rounds anyway.
 *
 * Asked for ONCE, at the moment the group is made, and never again:
 * after that the height is the person's, and a rule that reapplied it would
 * undo their drag every time they opened a terminal.
 */
const A_THIRD = 0.3333;

/**
 * The commands behind this, all four read out of the 1.133.0 bundle and
 * measured in a real host on 2026-08-13. They are commands and not API, so they
 * are named in one place: the day one of them is renamed, this is the file that
 * says what was being asked for.
 */
const NEW_GROUP_BELOW = 'workbench.action.newGroupBelow';
const LOCK_GROUP = 'workbench.action.lockEditorGroup';
const GET_LAYOUT = 'vscode.getEditorLayout';
const SET_LAYOUT = 'vscode.setEditorLayout';

/**
 * A group of the editor area that holds our terminals and nothing else.
 *
 * The owner asked for the agents to open "in a separate panel of their own, at
 * the bottom, the way ordinary terminals do". An extension cannot have a panel:
 * `TerminalLocation` offers the editor's single terminal panel -- shared with
 * every ordinary terminal, with no way to filter its list -- and the editor
 * area, and there is no third. What CAN be had is the same picture built out of
 * the parts the platform hands out, and every part of it was measured before it
 * was written:
 *
 *   * `newGroupBelow` splits the ACTIVE group in two rows rather than restacking
 *     the window, so a person working in two columns gets a strip under the
 *     column they were in and keeps their columns.
 *   * a locked group turns away an editor opened with no target -- measured: a
 *     document opened while the strip was the active group landed in the group
 *     above it -- and STILL takes ours, because we name its column outright.
 *     That asymmetry is the whole of "ours and nothing else".
 *   * the editor locks a terminal group BY ITSELF: `terminalEditor` is `true`
 *     in the default of `workbench.editor.autoLockGroups`, measured the same
 *     day. So the lock below is not what usually holds the strip -- it is what
 *     holds it for somebody who has turned that setting off, which is the only
 *     case where the promise would otherwise be broken by a preference that
 *     says nothing about us. The integration test turns it off for exactly that
 *     reason: with the platform's lock in play, no test can tell whether ours
 *     is there.
 *   * the editor closes a group that has nothing left in it, so the strip goes
 *     when its last terminal goes, and nothing here has to remember to take it
 *     away.
 *
 * What is NOT promised: a person can still drag a file into the strip, and the
 * editor renumbers columns when a group before ours closes. Both are handled the
 * same way -- the remembered column is checked before it is reused, and a strip
 * that is no longer ours is abandoned rather than argued with.
 */
export class VsCodeEditorStrip {
  private readonly _logger: Logger;
  private _column: vscode.ViewColumn | null = null;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  /** The column our terminals open in, making it if there is not one. */
  public async column(): Promise<vscode.ViewColumn> {
    const kept = this._kept();
    if (kept !== null) {
      return kept;
    }

    await vscode.commands.executeCommand(NEW_GROUP_BELOW);
    const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
    // Both act on the group that is active, which is the one just made -- the
    // command focuses it, and nothing is awaited in between that could move on.
    await vscode.commands.executeCommand(LOCK_GROUP);
    await this._askForAThird(column);

    this._column = column;
    this._logger.info('a group of our own was opened below the editors', { column });
    return column;
  }

  /**
   * The strip we made, if it is still there and still ours.
   *
   * Two ways it stops being either. The editor closes it when its last terminal
   * goes, and then the number names nothing -- or names a DIFFERENT group, since
   * closing a group renumbers the ones after it. And a person can drag a file
   * into it past the lock, which makes it their group as much as ours; a
   * terminal joining it then would be us insisting on a place we no longer own.
   */
  private _kept(): vscode.ViewColumn | null {
    const column = this._column;
    if (column === null) {
      return null;
    }
    const group = vscode.window.tabGroups.all.find((one) => one.viewColumn === column);
    if (group === undefined || group.tabs.some((tab) => !(tab.input instanceof vscode.TabInputTerminal))) {
      this._column = null;
      return null;
    }
    return column;
  }

  /**
   * A third of the space, asked for pointwise. `withGroupShare` answers `null`
   * when there is nothing to ask for -- a strip with no sibling, a layout with
   * no sizes yet -- and then nothing is asked for, rather than a layout being
   * written that says the same as the one already there.
   */
  private async _askForAThird(column: vscode.ViewColumn): Promise<void> {
    const layout = await vscode.commands.executeCommand<EditorLayout>(GET_LAYOUT);
    const next = withGroupShare(layout, column - 1, A_THIRD);
    if (next !== null) {
      await vscode.commands.executeCommand(SET_LAYOUT, next);
    }
  }
}
