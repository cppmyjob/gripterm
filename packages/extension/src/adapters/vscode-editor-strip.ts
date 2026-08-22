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
const NEW_GROUP_ABOVE = 'workbench.action.newGroupAbove';
const LOCK_GROUP = 'workbench.action.lockEditorGroup';
const GET_LAYOUT = 'vscode.getEditorLayout';
const SET_LAYOUT = 'vscode.setEditorLayout';

/**
 * How many times a split is asked for before this file believes the answer, and
 * how long it waits in between.
 *
 * **Measured, and the reason the retry exists at all (2026-08-22, Cursor
 * 1.x on Windows).** `workbench.action.newGroupBelow` does not always make a
 * group. Asked ten times over an editor area holding one EMPTY group, it made
 * nine and silently made none on the first; asked the same way with a file
 * open, five out of five. In one run of the same probe it threw outright --
 * `Invalid editor group provided!` -- from inside the workbench. The same probe
 * in VS Code stable: fifteen out of fifteen, and never a throw. So this is a
 * property of the editor the customer uses, on the state a window is in most
 * often right after it starts, and it is transient: the very next call worked
 * every time it was measured.
 */
const SPLIT_ATTEMPTS = 3;
const BETWEEN_ATTEMPTS_MS = 120;

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
 *     column they were in and keeps their columns. **It does not always do it,
 *     and the answer never says so** -- see `SPLIT_ATTEMPTS`, where the numbers
 *     are. Every split here is therefore asked for and then CHECKED.
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
  private readonly _watch: vscode.Disposable;
  private _column: vscode.ViewColumn | null = null;
  /** True while this object is making a group, so its own change is not answered. */
  private _arranging = false;

  constructor(logger: Logger) {
    this._logger = logger;
    this._watch = vscode.window.tabGroups.onDidChangeTabGroups(() => {
      void this._keepCompany();
    });
  }

  public dispose(): void {
    this._watch.dispose();
  }

  /** The column our terminals open in, making it if there is not one. */
  public async column(): Promise<vscode.ViewColumn> {
    const kept = this._kept();
    if (kept !== null) {
      return kept;
    }

    const empty = this._emptyAtTheEnd();
    if (empty !== null) {
      this._column = empty;
      // Locked only if it is already the group the editor is on -- the command
      // names no target and takes the active group, and moving the focus to lock
      // something would be a worse trade than the lock is worth. At the start of
      // a window the restored strip IS the active group (measured 2026-08-21),
      // which is the case this exists for; anywhere else the editor's own
      // `autoLockGroups.terminalEditor` locks it when our terminal opens.
      const active = vscode.window.tabGroups.activeTabGroup.viewColumn === empty;
      if (active) {
        await vscode.commands.executeCommand(LOCK_GROUP);
      }
      this._logger.info('the terminals went into the empty group at the end of the editor area', {
        column: empty,
        locked: active,
      });
      return empty;
    }

    const made = await this._splitOff(NEW_GROUP_BELOW);
    if (made === null) {
      /*
       * The editor would not make us a group, and this branch is the whole of
       * the customer's sixth complaint (see `SPLIT_ATTEMPTS` for the numbers).
       *
       * What this file used to do here was read the ACTIVE group's column and
       * carry on -- which, when the command had done nothing, was the person's
       * OWN and only group. It then locked it. A locked group holding our
       * terminals and filling the editor area is the trap exactly: "панель с
       * терминалами открывается на весь экран после загрузки", and the next
       * file the person opens has nowhere to go but BESIDE it -- "слева
       * терминал на всю высоту, а справа файл".
       *
       * So the terminals still go there, because a terminal the person asked
       * for is worth more than the shape it opens in, but NOTHING IS LOCKED and
       * nothing is resized. An unlocked group takes the person's next file
       * beside the terminals inside one group, which is untidy and is not a
       * trap: everything is visible and everything can be moved. The column is
       * remembered all the same, so `_keepCompany` recognises the group as ours
       * and puts a group above it as soon as the tab appears.
       */
      const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
      this._column = column;
      this._logger.warn('the editor would not make a group for the terminals, so they are going into the one that is there', {
        column,
        attempts: SPLIT_ATTEMPTS,
      });
      return column;
    }

    // Both act on the group that is active, which is the one just made -- the
    // command focuses it, and nothing is awaited in between that could move on.
    await vscode.commands.executeCommand(LOCK_GROUP);
    await this._askForAThird(made);

    this._column = made;
    this._logger.info('a group of our own was opened below the editors', { column: made });
    return made;
  }

  /**
   * Asks the editor to split off a group, and answers with the column of the
   * group that was REALLY made -- or `null` when none was.
   *
   * The check is the point. These are commands and not API: they answer with
   * `undefined` whether they did anything or not, and the only evidence that a
   * group appeared is that there is one more of them than there was. Reading
   * `activeTabGroup` without that check is reading the group the person was
   * already in and calling it ours, which is the defect this replaces.
   *
   * Retried because the failure was measured to be transient rather than a
   * refusal -- see `SPLIT_ATTEMPTS`. A throw is one of its shapes and is caught
   * here for the same reason: the next attempt is worth more than the stack.
   */
  private async _splitOff(command: string): Promise<vscode.ViewColumn | null> {
    for (let attempt = 1; attempt <= SPLIT_ATTEMPTS; attempt += 1) {
      const before = vscode.window.tabGroups.all.length;
      try {
        await vscode.commands.executeCommand(command);
      } catch (cause: unknown) {
        this._logger.warn('a split of the editor area threw', {
          command,
          attempt,
          cause: String(cause),
        });
      }
      if (vscode.window.tabGroups.all.length > before) {
        return vscode.window.tabGroups.activeTabGroup.viewColumn;
      }
      this._logger.info('a split of the editor area did nothing, and is being asked for again', {
        command,
        attempt,
        groups: before,
      });
      await new Promise((resolve) => setTimeout(resolve, BETWEEN_ATTEMPTS_MS));
    }
    return null;
  }

  /**
   * The strip is never the only group of the editor area.
   *
   * **The other half of the customer's sixth complaint, 2026-08-21**, and it is
   * the same lock that makes the strip a strip. When the person closes their
   * last file the editor takes the emptied group away; our group is left
   * holding the whole area, and a locked group that has no neighbour leaves the
   * editor nowhere to put the next file but BESIDE it. Measured: the area turns
   * horizontal, `[1] terminal | [2] file`, which is the "слева терминал на всю
   * высоту, справа файл" they could not get out of.
   *
   * So a group is made above, and the picture the person set up comes back --
   * measured on the same stand: with a group above, the next file lands in it.
   * The owner chose this over the two alternatives on 2026-08-21, with the
   * price in front of them: the terminals shrink at the moment the last file
   * closes, and there is empty space above them until something is opened.
   *
   * The height asked for is the same third the strip is made with, and for the
   * same reason -- the size it has at this instant is the whole area, which is
   * not a size anybody chose.
   */
  private async _keepCompany(): Promise<void> {
    if (this._arranging || vscode.window.tabGroups.all.length !== 1) {
      return;
    }
    // `at(0)` of a list this line has just established holds exactly one.
    const [only] = vscode.window.tabGroups.all;
    if (only === undefined) {
      return;
    }
    /*
     * Ours, and holding something. Asked as "a strip was made in this window
     * and the one group left holds terminals and nothing else" -- NOT as "its
     * column is the one we remember", which is the trap this file already warns
     * about twice: closing the group above renumbers ours, so by the time this
     * runs the remembered number names nothing. The first build of this rule
     * compared the number and never fired.
     *
     * A single EMPTY group is an editor area with nothing in it, which is how
     * every window starts and is nobody's problem.
     */
    const held =
      this._column !== null &&
      only.tabs.length > 0 &&
      only.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal);
    if (!held) {
      return;
    }
    this._column = only.viewColumn;

    this._arranging = true;
    try {
      if ((await this._splitOff(NEW_GROUP_ABOVE)) === null) {
        // Nothing is written down and nothing is given up: the column stays
        // what it was, so the next change to the tab groups brings this rule
        // back to the same state and asks again. That matters because the state
        // it is asking about is the trap -- a strip alone in the editor area --
        // and the alternative to asking again is leaving the person in it.
        this._logger.warn('the editor would not make a group above the terminals, which are alone in the editor area', {
          column: this._column,
        });
        return;
      }
      // Making a group above renumbers ours: the new one takes the column we
      // had. Read it back rather than assumed -- the whole file turns on that
      // number being right.
      const strip = vscode.window.tabGroups.all.find((group) =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal)
      );
      this._column = strip?.viewColumn ?? null;
      if (this._column !== null) {
        await this._askForAThird(this._column);
      }
      this._logger.info('a group was made above the terminals, which had the editor area to themselves', {
        column: this._column,
      });
    } finally {
      this._arranging = false;
    }
  }

  /**
   * A group at the END of the editor area with nothing in it: where the
   * terminals go rather than beside it.
   *
   * **The customer's first complaint, 2026-08-21:** "терминалы открываются в
   * отдельной панели. Однако если перезапустить приложение они откроются в новой
   * панели а старая панель останется пустой". Measured the same day in a real
   * editor, two sittings on one user data directory: the window comes back
   * holding `[1] (empty) | [2] (empty)` -- the editor restores the grid, our
   * strip among it, and the terminals in it are not restored because their
   * processes are gone -- and the restore then made a THIRD group. Every restart
   * added one, and the ones above shrank to slivers.
   *
   * The end of the area and nothing else, because that is where a strip is: it
   * is made below the editors, so it is the last leaf of the grid. A group in
   * the middle with nothing in it is somebody else's.
   *
   * **Never the ONLY group**, and that is the other half of the same defect
   * (complaint 6). A strip that fills the editor area is locked and alone, so
   * the editor has nowhere to put the person's next file but BESIDE it --
   * measured: opening a file then turns the area horizontal, `[1] terminal |
   * [2] file`, which is the "слева терминал на всю высоту, справа файл" they
   * could not get out of. With a group left above, the file lands in it.
   *
   * The size is NOT asked for here. The group the editor brought back has the
   * height the person left it at, and a third would be us undoing their drag on
   * every start.
   */
  private _emptyAtTheEnd(): vscode.ViewColumn | null {
    const groups = vscode.window.tabGroups.all;
    if (groups.length < 2) {
      return null;
    }
    const last = groups.reduce((furthest, group) =>
      group.viewColumn > furthest.viewColumn ? group : furthest
    );
    return last.tabs.length === 0 ? last.viewColumn : null;
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
