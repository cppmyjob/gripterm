import * as vscode from 'vscode';
import { isGriptermError, presentTerminal } from '@gripterm/core';
import { FINISHED_ROWS, whichTerminal } from './pick-terminal';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalLifecycleService } from '@gripterm/core';

export const START_OVER_COMMAND = 'gripterm.startOver';

/** The button, and the word this command is confirmed by. */
const CONFIRM = 'Start Over';

/**
 * `gripterm.startOver` -- the conversation could not be continued, so the work
 * moves to a new one (M2.13).
 *
 * This is the offer at the end of a failed restore, and the shape of it comes
 * from a measurement rather than from a state name. A26 established that
 * `claude --resume` on a conversation that is not there does not exit under a
 * pty: it prints its refusal into the pane and stays alive. So the record
 * reaches `degraded` with a LIVE process behind it, the person reads the reason
 * on screen, and the offer becomes available once they close that pane -- which
 * is the moment this window stops holding a process for it. The service refuses
 * until then, and refusing is what keeps one terminal from becoming two (О3).
 *
 * **Modal, like deletion, and for the same reason**: it archives a record. The
 * dialog says what crosses over, what does not, and -- in the sentence that
 * matters most -- how to reach the abandoned conversation afterwards. Its id is
 * the only handle on it that exists anywhere once the record naming it is in the
 * trash, so a dialog that omitted it would make one thing here irreversible
 * (§I.3).
 */
export function registerStartOver(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(START_OVER_COMMAND, async (target: unknown) => {
    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Start Over',
      placeHolder: 'Start which terminal over?',
      rows: FINISHED_ROWS,
      whenEmpty: 'Gripterm: every terminal of this window is still running.',
      // Asked even when there is one (M2.18): this archives the record whose
      // conversation id is the only handle on the old conversation.
      whenSole: 'ask',
      // Finished rows only, so the terminal on our screen is not among them.
      showing: null,
    });
    if (terminalId === null) {
      return;
    }

    const entry = registry.get(terminalId);
    if (entry === undefined) {
      // Gone between the picker and the choice. There is nothing to carry over
      // and nothing to archive.
      return;
    }

    const conversation = entry.sessionId.value;
    const answer = await vscode.window.showWarningMessage(
      `Start "${presentTerminal(entry).label}" over in a new conversation?`,
      {
        modal: true,
        detail:
          `A new Claude Code conversation starts in ${entry.launch.cwd}, and the name, task, ` +
          'notes and tags of this terminal move to it. The old record is moved to the trash ' +
          'folder of your Gripterm storage. The conversation it was having is NOT deleted — ' +
          `\`claude --resume ${conversation}\` still reaches it.`,
      },
      CONFIRM
    );
    // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
    if (answer !== CONFIRM) {
      return;
    }

    try {
      const outcome = await lifecycle.startOver(terminalId);
      if (outcome.kind === 'still-running') {
        say('warning', 'Gripterm: close this terminal before starting it over.', logger);
      }
    } catch (cause: unknown) {
      // The old record is untouched in this branch -- the service archives it
      // only after the new terminal exists -- so the person can simply try
      // again, and saying so is the whole obligation here.
      logger.error('a terminal could not be started over', { cause });
      say('error', `Gripterm: ${reason(cause)}`, logger);
    }
  });
}

/** Our own refusals carry a sentence written for a person; anything else does not. */
function reason(cause: unknown): string {
  return isGriptermError(cause) ? cause.message : 'the terminal could not be started, see the log';
}
