import * as vscode from 'vscode';
import {
  NAME_REQUIRED,
  NOTE_REQUIRED,
  TERMINAL_COLORS,
  formatTags,
  isBlank,
  parseTags,
} from '@gripterm/core';
import { EDITABLE_ROWS, whichTerminal } from './pick-terminal';
import type {
  Logger,
  SessionRegistry,
  TerminalEntry,
  TerminalId,
  TerminalMetadataService,
} from '@gripterm/core';

export const RENAME_TERMINAL_COMMAND = 'gripterm.renameTerminal';
export const SET_TASK_COMMAND = 'gripterm.setTask';
export const ADD_NOTE_COMMAND = 'gripterm.addNote';
export const EDIT_TAGS_COMMAND = 'gripterm.editTags';
export const SET_COLOR_COMMAND = 'gripterm.setColor';

/** The item that clears a colour. Its own object, so nothing has to parse a label. */
interface ColorPick extends vscode.QuickPickItem {
  readonly colorId: string | null;
}

/**
 * The five things a person changes about a record of their own (M2.7).
 *
 * Everything decided is decided in `TerminalMetadataService`, on the other side
 * of a port, because this package is outside the coverage thresholds (§3.5).
 * What remains here is a dialog apiece and one rule that belongs to dialogs
 * rather than to the domain:
 *
 * **Escape is an answer.** `showInputBox` returns `undefined` when somebody
 * changed their mind and `''` when they deliberately emptied the box, and the
 * difference decides what happens to a task: emptied means "there is no task
 * any more", changed their mind means nothing at all. A command that folded the
 * two together would clear a person's task every time they opened the box to
 * read it.
 *
 * The blank NAME and the blank NOTE are refused in the box itself rather than
 * afterwards, so that the refusal appears where the typing is and the person is
 * not told about it by a toast covering the row they were editing.
 */
export function registerMetadataCommands(
  metadata: TerminalMetadataService,
  registry: SessionRegistry,
  logger: Logger,
  showing: () => TerminalId | null
): readonly vscode.Disposable[] {
  const resolve = async (target: unknown, title: string): Promise<TerminalEntry | null> =>
    await entryFor(target, registry, logger, title, showing());

  return [
    vscode.commands.registerCommand(RENAME_TERMINAL_COMMAND, async (target: unknown) => {
      const entry = await resolve(target, 'Rename Terminal');
      if (entry === null) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'Rename Terminal',
        prompt: 'The name Gripterm shows in the list.',
        value: entry.metadata.displayName,
        validateInput: (typed) => (isBlank(typed) ? NAME_REQUIRED : null),
      });
      if (name === undefined) {
        return;
      }
      metadata.rename(entry.terminalId, name);
    }),

    vscode.commands.registerCommand(SET_TASK_COMMAND, async (target: unknown) => {
      const entry = await resolve(target, 'Set Task');
      if (entry === null) {
        return;
      }
      const task = await vscode.window.showInputBox({
        title: 'Set Task',
        prompt: 'What this terminal is for. Leave it empty to clear it.',
        value: entry.metadata.task ?? '',
      });
      if (task === undefined) {
        return;
      }
      metadata.setTask(entry.terminalId, task);
    }),

    vscode.commands.registerCommand(ADD_NOTE_COMMAND, async (target: unknown) => {
      const entry = await resolve(target, 'Add Note');
      if (entry === null) {
        return;
      }
      const text = await vscode.window.showInputBox({
        title: 'Add Note',
        prompt: 'A line about this terminal, kept with the record.',
        validateInput: (typed) => (isBlank(typed) ? NOTE_REQUIRED : null),
      });
      if (text === undefined) {
        return;
      }
      metadata.addNote(entry.terminalId, text);
    }),

    vscode.commands.registerCommand(EDIT_TAGS_COMMAND, async (target: unknown) => {
      const entry = await resolve(target, 'Edit Tags');
      if (entry === null) {
        return;
      }
      const typed = await vscode.window.showInputBox({
        title: 'Edit Tags',
        prompt: 'Tags separated by commas. An empty line removes them all.',
        value: formatTags(entry.metadata.tags),
      });
      if (typed === undefined) {
        return;
      }
      metadata.setTags(entry.terminalId, parseTags(typed));
    }),

    vscode.commands.registerCommand(SET_COLOR_COMMAND, async (target: unknown) => {
      const entry = await resolve(target, 'Set Colour');
      if (entry === null) {
        return;
      }
      const chosen = await vscode.window.showQuickPick(colorPicks(entry.metadata.color), {
        title: 'Set Colour',
        placeHolder: 'The colour of this row in the list.',
      });
      if (chosen === undefined) {
        return;
      }
      metadata.setColor(entry.terminalId, chosen.colorId);
    }),
  ];
}

/**
 * The colours, with the current one marked.
 *
 * The mark is a description rather than a `picked` flag, because this is a
 * single-choice pick and the flag only shows in a multi-select list -- a person
 * would otherwise have no way to see what they had chosen last time except by
 * cancelling and reading the row.
 */
function colorPicks(current: string | null): readonly ColorPick[] {
  const pick = (label: string, colorId: string | null): ColorPick =>
    // The key is omitted rather than set to `undefined`: under
    // `exactOptionalPropertyTypes` an absent description and an undefined one
    // are different things, and only one of them is what the platform means.
    colorId === current ? { label, description: 'current', colorId } : { label, colorId };

  return [
    ...TERMINAL_COLORS.map((color) => pick(color.label, color.id)),
    pick('No colour', null),
  ];
}

/**
 * The record a command was invoked on, or `null` when there is nothing to do.
 *
 * The ENTRY and not just the id, because every one of these dialogs opens
 * showing what is there now, and a rename box that starts empty is a rename box
 * that loses the name of anybody who opens it to look.
 *
 * The TITLE is the command's own, and it is passed down rather than written once
 * here: the picker and the box that follows it are one act, and a box headed
 * "Rename Terminal" behind a picker headed "Edit Terminal" is two.
 *
 * A record that went between the picker opening and the choice being made comes
 * back as `null` and is not reported. It is not an error: another window can
 * delete a record, and a dialog about it would interrupt somebody to tell them
 * about something they cannot act on.
 */
async function entryFor(
  target: unknown,
  registry: SessionRegistry,
  logger: Logger,
  title: string,
  showing: TerminalId | null
): Promise<TerminalEntry | null> {
  const terminalId: TerminalId | null = await whichTerminal(registry, logger, {
    target,
    title,
    // Says that a second dialog follows, because the two read as ONE to the
    // person who did not build them: the owner met this twice (M3.10 and the
    // M3.14 acceptance), and the first time the note itself went into this
    // filter box, where it matched no row and Enter did nothing. The wording is
    // all this change is -- which terminal a command acts on is a decision, and
    // `chooseTerminal` says why acting on one nobody picked is worse than one
    // dialog too many.
    placeHolder: 'Which terminal? The change itself comes next.',
    /*
     * The one picker that puts a row at the top: the terminal on this window's
     * own screen, marked as such. Owner's decision, 2026-08-20.
     *
     * The half deliberately NOT taken is to act on it without asking. These
     * five commands are the ones a person opens repeatedly and by reflex, and a
     * note written into a record nobody chose is worse than one dialog too many
     * -- the same reasoning `chooseTerminal` carries, and the reason the answer
     * is still an Enter rather than nothing.
     */
    showing,
    rows: EDITABLE_ROWS,
    whenEmpty: 'Gripterm: there is no terminal of this window to edit.',
    // The only row there could be is the one being edited, and the box that
    // opens next shows its current value with its own title above it (M2.18).
    whenSole: 'take',
  });
  if (terminalId === null) {
    return null;
  }
  return registry.get(terminalId) ?? null;
}
