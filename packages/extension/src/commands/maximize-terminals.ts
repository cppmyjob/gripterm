import * as vscode from 'vscode';
import type { Logger } from '@gripterm/core';
import { aTerminalIsInFront } from '../ui/terminal-in-front';

export const MAXIMIZE_TERMINALS_COMMAND = 'gripterm.maximizeTerminals';

const TOGGLE_MAXIMIZE_GROUP = 'workbench.action.toggleMaximizeEditorGroup';

export interface MaximizeTerminalsOptions {
  /**
   * Puts the editor on the strip, answering whether it went. `false` when this
   * window has no strip -- no terminals in one, or terminals that do not live
   * in a strip at all.
   */
  readonly standOnTheStrip: () => Promise<boolean>;
  readonly logger: Logger;
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
 */
export function registerMaximizeTerminals(options: MaximizeTerminalsOptions): vscode.Disposable {
  const toggle = async (): Promise<void> => {
    const stood = await options.standOnTheStrip();
    if (!stood && !aTerminalIsInFront()) {
      options.logger.info('there was nothing of ours in front to maximise, so nothing was maximised');
      return;
    }
    await vscode.commands.executeCommand(TOGGLE_MAXIMIZE_GROUP);
    options.logger.info('the group holding the terminals was maximised or put back', {
      stoodOnTheStrip: stood,
    });
  };

  return vscode.commands.registerCommand(MAXIMIZE_TERMINALS_COMMAND, toggle);
}
