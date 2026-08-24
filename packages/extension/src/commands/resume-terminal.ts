import * as vscode from 'vscode';
import { explainRefusal, isGriptermError, presentTerminal, resumeIntent } from '@gripterm/core';
import { FINISHED_ROWS, whichTerminal } from './pick-terminal';
import { say } from '../ui/say';
import type {
  Logger,
  RestoreInputs,
  SessionRegistry,
  TerminalEntry,
  TerminalLifecycleService,
} from '@gripterm/core';

export const RESUME_TERMINAL_COMMAND = 'gripterm.resumeTerminal';

/** The word a person confirms bringing back a terminal THEY closed with. */
const CONFIRM_CLOSED = 'Resume Anyway';

export interface ResumeTerminalParts {
  readonly lifecycle: TerminalLifecycleService;
  readonly registry: SessionRegistry;
  /**
   * The same gatherer activation and adoption use, or `null` in a window with no
   * shared base.
   *
   * Not a convenience: what it reads is the answer to "is a `claude` already on
   * this conversation", and a second reading of that question is how two
   * processes end up writing one transcript (О3).
   */
  readonly gather: (() => Promise<RestoreInputs>) | null;
  readonly logger: Logger;
}

/**
 * `gripterm.resumeTerminal` -- start this record's conversation again, here
 * (M2.23).
 *
 * **The hole it fills was the size of the product.** A person exited Claude Code
 * with Ctrl+C, and the row that was left offered the journal, a new conversation
 * (`Start Over`, which walks away from theirs) and deletion -- nothing that
 * brought the conversation back. The only thing in this build that resumes
 * anything ran ONCE, at activation, over records belonging to windows that are
 * GONE (§6, M2.11); a record whose own window is still open was outside every
 * path there is. So the answer to "bring it back" was "reload the editor, and
 * hope".
 *
 * **It is the same predicate, not a second one.** `resumeRefusal` is
 * `planRestore`'s own rules with the three about ownership taken out -- whose
 * window this is, whether it answers, whose project it is -- because the asker
 * is that window, standing in that project, with the row under the cursor.
 * Everything about the conversation stays: our own evidence of the process, the
 * CLI's list, the transcript, and a twin naming the same session. That is what
 * keeps this from becoming the second `claude --resume` on a live conversation.
 *
 * **A record the person CLOSED is offered too, behind a modal.** `closedAt` says
 * "do not bring this back", it is an intention rather than a fact, and its
 * author is the one asking. Refusing them would leave a terminal closed by
 * mistake with no way back at all -- and the alternative, hiding the entry on
 * those rows, is a menu that changes shape for a reason nobody can see.
 *
 * **A record nothing was ever said in comes back too, with a NEW conversation**
 * (customer, 2026-08-21: "если открыть новый терминал и туда ничего не вводить
 * и закрыть терминал принудительно, то это окно нельзя восстановить через
 * зелёную кнопку"). The rule is the owner's, taken the same day for the
 * automatic path; the button simply had not followed it. The difference from a
 * resume is said out loud, because the button promised one.
 *
 * No dialog otherwise: the terminal opening IS the answer, and it can be closed
 * again by whoever asked.
 */
export function registerResumeTerminal(parts: ResumeTerminalParts): vscode.Disposable {
  return vscode.commands.registerCommand(RESUME_TERMINAL_COMMAND, async (target: unknown) => {
    const { lifecycle, registry, gather, logger } = parts;
    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Resume Terminal',
      placeHolder: 'Resume which terminal?',
      rows: FINISHED_ROWS,
      whenEmpty: 'Gripterm: every terminal of this window is still running.',
      // Taken when there is only one (M2.18): this opens a terminal and takes
      // nothing away, and what it is about to do is visible the moment it does.
      whenSole: 'take',
      // Every candidate here is a terminal that is OVER, and the one on our
      // screen is running -- there is nothing of this list to be looking at.
      showing: null,
    });
    if (terminalId === null) {
      return;
    }

    const entry = registry.get(terminalId);
    if (entry === undefined) {
      // Gone between the picker and the choice. There is nothing to resume.
      return;
    }
    const label = presentTerminal(entry).label;
    if (gather === null) {
      // Without the base this window cannot establish that no `claude` is on
      // that conversation, and nothing here starts on a guess.
      say(
        'info',
        `Gripterm: this window is not reading the shared store, so it cannot tell whether "${label}" is already running somewhere.`,
        logger
      );
      return;
    }

    try {
      await resume({ entry, label, lifecycle, gather, logger });
    } catch (cause: unknown) {
      logger.error('a terminal could not be resumed', {
        terminalId: terminalId.value,
        cause,
      });
      say('error', `Gripterm: ${reason(cause)}`, logger);
    }
  });
}

/** The predicate, the person's own close, and then the start. */
async function resume(parts: {
  readonly entry: TerminalEntry;
  readonly label: string;
  readonly lifecycle: TerminalLifecycleService;
  readonly gather: () => Promise<RestoreInputs>;
  readonly logger: Logger;
}): Promise<void> {
  const { entry, label, lifecycle, gather, logger } = parts;

  const decision = resumeIntent(entry, await gather());
  if (decision.kind === 'refused') {
    // The predicate said no and it says why -- in the union's own words, so
    // that the sentence a person reads here is the sentence they would read
    // about the same record at activation.
    say('warning', `Gripterm: "${label}" was not resumed — ${explainRefusal(decision.reason)}.`, logger);
    return;
  }

  if (!entry.isRestorable() && !(await confirmReopen(label))) {
    return;
  }
  const fresh = decision.intent === 'launch';
  logger.info('a person asked this window to resume a terminal it holds', {
    terminalId: entry.terminalId.value,
    sessionId: entry.sessionId.value,
    reopened: !entry.isRestorable(),
    intent: decision.intent,
  });
  /*
   * `reopened()` answers itself when there was no close, so the ordinary path
   * carries no special case. `start` registers what it stamps, which is how the
   * cleared `closedAt` reaches the store.
   *
   * `startAgain` is the other of the two ways back, and the record chooses it
   * rather than the person: nothing was ever said in this conversation, so
   * `--resume` on it is measured to fail and a new one is drawn instead. The
   * record -- its name, its task, its notes -- is what a person wanted back, and
   * it is kept whole; only the conversation id, which pointed at nothing, moves
   * into the history.
   */
  await (fresh ? lifecycle.startAgain(entry.reopened()) : lifecycle.start(entry.reopened(), 'resume'));
  if (fresh) {
    // Said aloud, because the button promised a resume and this is not one. A
    // person who is not told will look for their conversation in an empty
    // terminal and conclude the tool lost it.
    say(
      'info',
      `Gripterm: nothing had been said in "${label}", so there was no conversation to resume — it is back with a new one.`,
      logger
    );
  }
}

/**
 * What the person is reversing, when what they are reversing is their own act.
 *
 * Modal, like the three commands that take something away, and for the mirror
 * of their reason: this puts something back that a rule has been told to forget,
 * and the rule is one the person themselves set. What it does NOT do is warn --
 * there is nothing dangerous here, and the guards that matter have already
 * answered.
 */
async function confirmReopen(label: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Resume "${label}", although you closed this terminal?`,
    {
      modal: true,
      detail:
        'You closed this terminal on purpose, so Gripterm stopped offering to bring it back and ' +
        'would have forgotten its record at the next start. Resuming it takes that back: the ' +
        'conversation continues here and the record stays.',
    },
    CONFIRM_CLOSED
  );
  // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
  return answer === CONFIRM_CLOSED;
}

/** Our own refusals carry a sentence written for a person; anything else does not. */
function reason(cause: unknown): string {
  return isGriptermError(cause) ? cause.message : 'the terminal could not be resumed, see the log';
}
