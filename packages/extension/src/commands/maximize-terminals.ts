import * as vscode from 'vscode';
import type { Logger } from '@gripterm/core';

export const MAXIMIZE_TERMINALS_COMMAND = 'gripterm.maximizeTerminals';
export const RESTORE_TERMINALS_COMMAND = 'gripterm.restoreTerminals';

/**
 * The editor's own toggle, named in one place.
 *
 * A command and not an API -- there is no way to maximise a group through
 * `vscode.window` -- so it is read out of the bundles before it is used and the
 * day it is renamed, this is the file that says what was being asked for. Read
 * 2026-08-21 out of VS Code 1.134.0 (`workbench.desktop.main.js`) and out of
 * Cursor's own bundle: present in both, spelled the same.
 */
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
 * **Two commands for one act, and that is the whole reason there are two.** An
 * icon belongs to a command, not to a menu entry, so a single toggle can only
 * ever wear one chevron. Contributed twice with opposite `when` clauses on
 * `editorPartMaximizedEditorGroup`, the button points up when there is room to
 * grow and down when there is a way back -- which is what a person reads before
 * they read anything else.
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

  return vscode.Disposable.from(
    vscode.commands.registerCommand(MAXIMIZE_TERMINALS_COMMAND, toggle),
    vscode.commands.registerCommand(RESTORE_TERMINALS_COMMAND, toggle)
  );
}
