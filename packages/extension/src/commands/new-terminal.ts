import * as vscode from 'vscode';
import { LaunchRecipe, defaultTerminalName, isGriptermError } from '@gripterm/core';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalLifecycleService } from '@gripterm/core';

export const NEW_TERMINAL_COMMAND = 'gripterm.newTerminal';

/**
 * `gripterm.newTerminal` -- the first half of П1, and a thin wrapper by design.
 *
 * Everything it decides is decided on the other side of a port: the name comes
 * from `defaultTerminalName`, the record and the process from
 * `TerminalLifecycleService`. What is left here is the editor's own knowledge --
 * which folder is open, and how to tell somebody that it did not work.
 *
 * There is no prompt for a name. Naming and renaming arrive with the notes in
 * M2.7; a dialog in front of every new terminal would be a toll on the one
 * action this extension exists to make cheap.
 */
export function registerNewTerminal(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(NEW_TERMINAL_COMMAND, async () => {
    const cwd = firstFolder();
    if (cwd === null) {
      // Not a crash and not a silent no-op: `claude` is started IN a project,
      // and a session with nowhere to run is not something to invent a default
      // for.
      say(
        'warning',
        'Gripterm: open a folder first — a Claude Code session runs in a project directory.',
        logger
      );
      return;
    }

    try {
      await lifecycle.launch({
        displayName: defaultTerminalName(
          cwd,
          registry.list().map((entry) => entry.metadata.displayName)
        ),
        // Bare in M1: the flags a person can choose -- permission mode, model,
        // extra directories -- arrive with the launch dialog of M2.14, and the
        // recipe is stored whole precisely so that they can.
        recipe: LaunchRecipe.create({
          cwd,
          addDirs: [],
          permissionMode: null,
          agent: null,
          model: null,
          worktree: null,
          mcpConfigPaths: [],
          appendSystemPrompt: null,
          extraEnv: {},
        }),
      });
    } catch (cause: unknown) {
      // The person pressed a button and nothing appeared. Saying so is the
      // whole obligation here; the detail goes to the log, where it can be read
      // without being in the way.
      logger.error('a terminal could not be started', { cause });
      say('error', `Gripterm: ${reason(cause)}`, logger);
    }
  });
}

/**
 * The first workspace folder.
 *
 * First rather than chosen: a multi-root workspace asking which folder before
 * every terminal is the toll this command avoids, and M2.14's dialog is where
 * the choice belongs. The limit is stated rather than hidden.
 */
function firstFolder(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder === undefined ? null : folder.uri.fsPath;
}

/** Our own refusals carry a sentence written for a person; anything else does not. */
function reason(cause: unknown): string {
  return isGriptermError(cause) ? cause.message : 'the terminal could not be started, see the log';
}
