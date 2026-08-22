import * as vscode from 'vscode';
import { groupShare, withGroupShare } from '@gripterm/core';
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
 * How many times the strip's size is looked at before the asking stops, and
 * how long the repair of a strip left alone waits between its rounds.
 *
 * The looks exist because the editor answers `getEditorLayout` with a layout it
 * has not laid out yet -- measured, and the numbers are in `_askForAThird`.
 * Five looks at 120 ms is 480 ms of patience for something that took one tick
 * every time it was watched.
 *
 * The rounds are longer and for a different reason: `_keepCompany` is the only
 * thing standing between a person and a layout they cannot get out of, and the
 * three quick attempts it used to make were over in a third of a second. Four
 * rounds waiting half a second more each time is three seconds of patience --
 * a refusal measured to be transient deserves to be waited out, not reported.
 */
/**
 * What came of asking for a third: it is a third now, the editor has not laid
 * the group out yet and can be asked again, or it was laid out and stayed too
 * big. Only the middle one is worth coming back to.
 */
type AThird = 'settled' | 'unlaid' | 'refused';

const SHARE_LOOKS = 5;
const A_SHADE_OVER = 0.05;
const REPAIR_ROUNDS = 4;
const REPAIR_WAIT_MS = 500;

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
  /**
   * True while the strip still owes the editor a size.
   *
   * The size is asked for when the group is MADE, which is before the terminal
   * that is going into it exists -- and an editor does not lay out a group with
   * nothing in it. Measured in Cursor on 2026-08-22: `getEditorLayout` answers
   * with no sizes at all until the tab appears, and then answers 70/673. So the
   * asking cannot end when the group is made: what is owed is remembered, and
   * paid the moment the group's tabs change.
   */
  private _owed = false;

  constructor(logger: Logger) {
    this._logger = logger;
    const look = (): void => {
      void this._afterAChange();
    };
    // Both events, because they are different: a group appearing or going is a
    // group change, and a TAB appearing in a group is a tab change -- and the
    // tab is what makes the editor lay the group out at all.
    this._watch = vscode.Disposable.from(
      vscode.window.tabGroups.onDidChangeTabGroups(look),
      vscode.window.tabGroups.onDidChangeTabs(look)
    );
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
    /*
     * Owed no matter what that answered, and this is the measured heart of it
     * (Cursor, 2026-08-22, from this build's own log):
     *
     *   look 1  share 0.906  [{size:70},{size:673}]
     *   look 2  share 0.334  [{size:495},{size:248}]   <- ours, and it took
     *   +400 ms              [{size:70},{size:673}]    <- and was given back
     *
     * A group with nothing in it is a group the editor sizes by what is about
     * to go into it, and the terminal is not there yet: `column()` runs BEFORE
     * `createTerminal`. So a third granted here is provisional, and the debt
     * stands until the group has a tab to be sized around.
     */
    this._owed = true;

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
   * Everything this object does in answer to the editor moving something.
   *
   * Two rules, in this order and not the other: a strip alone in the editor
   * area is a trap and is undone first, and only then is a size asked for --
   * because making a group above renumbers ours, and a size asked for the old
   * number would be a size asked for somebody else's group.
   */
  private async _afterAChange(): Promise<void> {
    await this._keepCompany();
    await this._payWhatIsOwed();
  }

  /**
   * The size the strip was promised when its group was made, asked for again
   * now that there is something in the group to lay out.
   *
   * Once, and only while it is owed: `_askForAThird` never grows the strip, so
   * the moment a real share is read and it is no more than a third the debt is
   * gone and no later drag of the person's is ever answered.
   */
  private async _payWhatIsOwed(): Promise<void> {
    if (!this._owed || this._arranging) {
      return;
    }
    const column = this._kept();
    if (column === null) {
      // The group is gone, or is not ours any more. Nothing is owed to it.
      this._owed = false;
      return;
    }
    const group = vscode.window.tabGroups.all.find((one) => one.viewColumn === column);
    if (group === undefined || group.tabs.length === 0) {
      // Still empty, so still the answer that was measured to be provisional.
      // The debt stands and the next change to the tabs asks again.
      return;
    }
    this._arranging = true;
    try {
      this._owed = (await this._askForAThird(column)) === 'unlaid';
    } finally {
      this._arranging = false;
    }
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
    if (this._arranging || !this._aloneInTheArea()) {
      return;
    }

    this._arranging = true;
    try {
      for (let round = 1; round <= REPAIR_ROUNDS; round += 1) {
        // Nothing before the first round: the trap is already there, and the
        // waiting is for the rounds that follow a refusal.
        const wait = (round - 1) * REPAIR_WAIT_MS;
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        if (!this._aloneInTheArea()) {
          // The person opened something, or the editor brought a group back.
          // Either way the trap this repairs is not there any more.
          return;
        }
        if ((await this._splitOff(NEW_GROUP_ABOVE)) !== null) {
          await this._settleAbove();
          return;
        }
        this._logger.info('the editor would not make a group above the terminals, and is being given a moment', {
          column: this._column,
          waited: wait,
        });
      }
      /*
       * Every ask refused, and this is the one state where giving up costs the
       * person the window they set up: a strip alone in the editor area is
       * locked, so the next file they open has nowhere to go but BESIDE it, and
       * from then on there are two groups -- which is not the state this rule
       * watches for, so nothing here ever asks again. The waits above exist for
       * exactly that: the editor's refusal was measured to be transient, and
       * the alternative to waiting it out is leaving somebody in a layout they
       * cannot get out of.
       */
      this._logger.warn('the editor would not make a group above the terminals, which are alone in the editor area', {
        column: this._column,
        asked: REPAIR_ROUNDS,
      });
    } finally {
      this._arranging = false;
    }
  }

  /**
   * True when the editor area holds our strip and nothing else, which is the
   * trap `_keepCompany` exists to undo. Remembers the column while it is at it,
   * because that is the one moment the number is known to be right.
   *
   * Asked as "the one group left holds terminals and nothing else" -- NOT as
   * "its column is the one we remember", which is the trap this file already
   * warns about twice: closing the group above renumbers ours, so by the time
   * this runs the remembered number names nothing. The first build of this rule
   * compared the number and never fired.
   *
   * A single EMPTY group is an editor area with nothing in it, which is how
   * every window starts and is nobody's problem.
   */
  private _aloneInTheArea(): boolean {
    const groups = vscode.window.tabGroups.all;
    const [only] = groups;
    if (groups.length !== 1 || only === undefined) {
      return false;
    }
    const held =
      this._column !== null &&
      only.tabs.length > 0 &&
      only.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal);
    if (!held) {
      return false;
    }
    this._column = only.viewColumn;
    return true;
  }

  /** After a group is made above ours: find ourselves again, and take a third. */
  private async _settleAbove(): Promise<void> {
    // Making a group above renumbers ours: the new one takes the column we had.
    // Read it back rather than assumed -- the whole file turns on that number
    // being right.
    const strip = vscode.window.tabGroups.all.find((group) =>
      group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal)
    );
    this._column = strip?.viewColumn ?? null;
    if (this._column !== null) {
      this._owed = (await this._askForAThird(this._column)) === 'unlaid';
    }
    this._logger.info('a group was made above the terminals, which had the editor area to themselves', {
      column: this._column,
    });
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
   * A third of the space, asked for pointwise and then LOOKED AT.
   *
   * **The customer's sixth complaint, second half, measured 2026-08-22 in
   * Cursor.** The plus was pressed with the list focused in a window that had
   * only just started, and the strip came out holding 673 pixels of the 743 the
   * editor area had -- "появляется новый терминал на всю область файлов". Every
   * part of this file had done its job and none of them had lied: the split was
   * made and checked, `withGroupShare` was handed the layout the editor
   * answered with, and that layout had no sizes in it yet, so it answered `null`
   * -- correctly, because there was nothing to divide. What was missing is the
   * line below: the caller could not tell "the editor is not laid out yet" from
   * "the strip is a third", and the strip kept whatever the split gave it.
   *
   * So the size is read back, and the asking repeats until the answer is a size
   * or the looks run out. `null` is not a share of zero and must never be read
   * as one -- see `groupShare`, which is where that distinction lives.
   *
   * **Never grows the strip**, and that is what makes a loop here safe: a share
   * already at or under a third is left exactly as it is, so a person who has
   * dragged the strip smaller keeps their drag, and the loop can only ever run
   * where nobody has chosen the size yet.
   *
   * Answers with which of three things happened, because the two ways of not
   * succeeding are answered differently. `unlaid` is a group the editor has not
   * laid out -- an empty one, which is every strip at the moment it is made --
   * and it is worth coming back to when its tabs change. `refused` is a group
   * that was laid out, was too big, and stayed too big through every look;
   * coming back to that one would be asking the same question forever.
   */
  private async _askForAThird(column: vscode.ViewColumn): Promise<AThird> {
    let last: number | null = null;
    for (let look = 1; look <= SHARE_LOOKS; look += 1) {
      const layout = await vscode.commands.executeCommand<EditorLayout>(GET_LAYOUT);
      last = groupShare(layout, column - 1);
      // The editor's own answer, in the log, because every defect this file has
      // had was a disagreement between what it asked for and what it got --
      // and the only place the disagreement is visible is here.
      this._logger.info('the editor was asked what the terminals are holding', {
        column,
        look,
        share: last,
        layout: JSON.stringify(layout),
      });
      if (last !== null && last <= A_THIRD + A_SHADE_OVER) {
        return 'settled';
      }
      const next = withGroupShare(layout, column - 1, A_THIRD);
      if (next !== null) {
        await vscode.commands.executeCommand(SET_LAYOUT, next);
      }
      if (look < SHARE_LOOKS) {
        await new Promise((resolve) => setTimeout(resolve, BETWEEN_ATTEMPTS_MS));
      }
    }
    if (last === null) {
      // Nothing is wrong yet: an empty group is a group the editor has not laid
      // out, and the terminal that will make it lay one out is not there yet.
      this._logger.info('the editor has not sized the group of the terminals, so the size will be asked for again', {
        column,
        looks: SHARE_LOOKS,
      });
      return 'unlaid';
    }
    this._logger.warn('the terminals are holding more of the editor area than the third they were made with', {
      column,
      share: last,
      looks: SHARE_LOOKS,
    });
    return 'refused';
  }
}
