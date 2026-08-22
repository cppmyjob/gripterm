import * as vscode from 'vscode';
import type { Logger } from '@gripterm/core';

export const MAXIMIZE_TERMINALS_COMMAND = 'gripterm.maximizeTerminals';

const TOGGLE_MAXIMIZE_GROUP = 'workbench.action.toggleMaximizeEditorGroup';

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
 * **What acts, and the price of it.** The editor's toggle takes the ACTIVE
 * group and names no target, so this button maximises whichever group is
 * active. In front of the button that is the group whose title bar was
 * clicked; from the palette it is wherever the person was. The price: there is
 * no `when` clause that can say "this group is Gripterm's", so the button also
 * appears on a terminal the person moved into the editor area themselves -- and
 * there it does the same, sensible thing. REMOVED WHEN: a build offers a
 * context key that names the group an extension made.
 */
export function registerMaximizeTerminals(logger: Logger): vscode.Disposable {
  const toggle = async (): Promise<void> => {
    await vscode.commands.executeCommand(TOGGLE_MAXIMIZE_GROUP);
    logger.info('the group holding the terminals was maximised or put back');
  };

  return vscode.commands.registerCommand(MAXIMIZE_TERMINALS_COMMAND, toggle);
}
