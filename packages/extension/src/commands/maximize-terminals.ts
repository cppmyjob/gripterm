import * as vscode from 'vscode';
import type { Logger } from '@gripterm/core';
import { aTerminalIsInFront } from '../ui/terminal-in-front';

export const MAXIMIZE_TERMINALS_COMMAND = 'gripterm.maximizeTerminals';

const TOGGLE_MAXIMIZE_GROUP = 'workbench.action.toggleMaximizeEditorGroup';

/**
 * The editor's own answer about the shape of its area, and the only evidence
 * this command has that the toggle did anything at all.
 *
 * A command and not API, like the toggle itself: it answers `undefined` in a
 * host that does not have it, which is why the reading is allowed to be `null`
 * and why a `null` reading is never read as "nothing happened".
 */
const GET_LAYOUT = 'vscode.getEditorLayout';

export interface MaximizeTerminalsOptions {
  /**
   * Puts the editor on the strip, answering whether it went. `false` when this
   * window has no strip -- no terminals in one, or terminals that do not live
   * in a strip at all.
   */
  readonly standOnTheStrip: () => Promise<boolean>;
  /**
   * What the person is told when the button did nothing.
   *
   * A button that declines in silence is the defect the owner reported on
   * 2026-08-27 as "нет реакции на кнопку Maximise the Terminal": from where he
   * sat, a working button and a broken one look exactly alike.
   */
  readonly announce: (message: string) => void;
  readonly logger: Logger;
}

/** The editor area as the editor describes it, or `null` when it will not say. */
async function editorLayout(logger: Logger): Promise<string | null> {
  try {
    const answer = await vscode.commands.executeCommand(GET_LAYOUT);
    return answer === undefined ? null : JSON.stringify(answer);
  } catch (cause: unknown) {
    logger.warn('the editor would not say how its area is laid out', { cause });
    return null;
  }
}

/**
 * The button the customer asked for on 2026-08-21: "хотелось бы в панели иметь
 * кнопку, которая бы распахивала бы панель на всю высоту экрана, скрывая тем
 * самым окна с файлами вверху, и после при повторном клике возвращалась бы на
 * место -- такая кнопка есть в Cursor в панели с терминалами".
 *
 * Our terminals do not live in a panel: under the editor engine they live in a
 * GROUP of the editor area that is ours (M2.24). What the editor's panel calls
 * maximising, the editor area calls maximising a group, and the toggle above is
 * the same one the person's own chevron uses -- so this is a button in front of
 * a behaviour they already have, not a behaviour of ours.
 *
 * **ONE button and one icon, because the editor will not say which state we are
 * in.** It was two at first, with the chevron pointing up or down against
 * `editorPartMaximizedEditorGroup` -- and the owner found the defect by looking
 * at it on 2026-08-22: with the group already maximised the button still said
 * "Maximise", and pressing it put the group back. The key exists in both
 * bundles and does not reach this menu, so the arrow was telling a person the
 * opposite of the truth about their own window.
 *
 * An icon that cannot follow the state is not made honest by picking one of the
 * two states and hoping. So there is one button, it says what it does -- both
 * halves of it -- and the act is a toggle, which is exactly what the customer
 * asked for: "распахивал бы панель на всю высоту... при повторном клике
 * возвращалась бы на место".
 *
 * **What it acts on, and why that changed on 2026-08-22.** The editor's toggle
 * takes the ACTIVE group and names no target. That was left as it stood while
 * the only way to the button was a terminal's own tab bar, where the active
 * group IS the strip. Then the button was put ALSO in the title bar of the list
 * of terminals -- and from there the active group is whatever file the person
 * last touched, and a toggle would have maximised THAT: the same class of
 * defect as the arrow, a button doing the opposite of what it says.
 *
 * **Why Cursor did not draw it in the tab bar, found 2026-08-26 and no longer
 * true of this build.** Not the condition: the key was measured correct in
 * Cursor three times over. The fork hides, BY DEFAULT AND IN `editor/title`
 * ONLY, every command an extension contributes there unless its id begins with
 * one of ten prefixes of the editor's own -- `PersistedMenuHideState.isHidden`,
 * `_isEditorTitleCommandVisibleByDefault`, in both of its workbenches and in
 * neither of VS Code's. The manifest now reaches that bar through a SUBMENU of
 * one item, which that rule does not cover and which the editor folds back into
 * the single icon; `tests/extension/editor-title-in-the-fork.test.ts` carries
 * the mechanism, the way through and the numbers both were measured with.
 *
 * So the strip is stood on first. When there is no strip to stand on, the
 * button acts only if the editor in front is a terminal -- the case of a
 * terminal the person moved into the editor area themselves, where it does the
 * same sensible thing -- and otherwise does nothing but say so. A button that
 * maximises somebody's source file is worse than a button that declines.
 *
 * **What the toggle cannot do, and what this used to say about it (2026-08-27).**
 * `toggleMaximizeEditorGroup` maximises a group OVER the other groups of the
 * editor area, so in an area that holds one group there is nothing for it to
 * do -- measured in a real host that day: `vscode.getEditorLayout` answers the
 * same object before and after, to the pixel. The line under it nevertheless
 * said `the group holding the terminals was maximised or put back` every time,
 * with nothing between the ask and the claim: a log asserting what it had never
 * checked (I.1), in the one file a person can be asked to send. It is the state
 * the owner met, and both halves of what he met are here -- the log said the
 * thing was done, and the window said nothing at all.
 *
 * So the layout is read on either side of the toggle and the log says which of
 * the three happened; and when nothing happened the person is told, because
 * from in front of the screen a button that declines and a button that is
 * broken are the same button.
 */
export function registerMaximizeTerminals(options: MaximizeTerminalsOptions): vscode.Disposable {
  const toggle = async (): Promise<void> => {
    const stood = await options.standOnTheStrip();
    if (!stood && !aTerminalIsInFront()) {
      options.logger.info('there was nothing of ours in front to maximise, so nothing was maximised');
      options.announce('Gripterm: there is no terminal in front of you to maximise.');
      return;
    }
    const before = await editorLayout(options.logger);
    await vscode.commands.executeCommand(TOGGLE_MAXIMIZE_GROUP);
    const after = await editorLayout(options.logger);
    /*
     * Read AFTER the toggle, so that the number in the log is the number the
     * reading above was taken over.
     *
     * `tabGroups.all` and not the editor area, and the difference is named
     * because this file cannot close it: in Cursor the list carries groups from
     * an editor part the grid does not hold -- see `_areaGroups` in
     * `vscode-editor-strip.ts`, measured over ten runs of the stand. So this
     * number chooses which SENTENCE the person is told and never whether
     * anything happened, which is decided by the two readings above and by
     * nothing else.
     */
    const groups = vscode.window.tabGroups.all.length;
    if (before === null || after === null) {
      /*
       * The one answer that is neither of the other two, and it is not folded
       * into "nothing happened": a host that will not describe its own area has
       * told us nothing about what the toggle did, and saying "nothing" there
       * would be the same defect over again with the sign reversed.
       */
      options.logger.warn('the terminals were asked to be maximised, and the editor would not say whether anything moved', {
        stoodOnTheStrip: stood,
        groups,
      });
      return;
    }
    if (before === after) {
      options.logger.warn('the editor area is exactly as it was, so there was nothing to maximise', {
        stoodOnTheStrip: stood,
        groups,
      });
      options.announce(
        groups <= 1
          ? 'Gripterm: the terminals already have the whole editor area, so there is nothing to maximise them over.'
          : 'Gripterm: the editor did not maximise the terminals.'
      );
      return;
    }
    options.logger.info('the group holding the terminals was maximised or put back', {
      stoodOnTheStrip: stood,
      groups,
    });
  };

  return vscode.commands.registerCommand(MAXIMIZE_TERMINALS_COMMAND, toggle);
}
