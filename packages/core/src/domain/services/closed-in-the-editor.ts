/**
 * What a person is offered after the editor closes one of our terminals, and
 * what their answer means.
 *
 * **The road this stands in, measured 2026-08-27 (Sh26).** The cross on the
 * editor's own tab reaches no command of ours. The editor closes the terminal
 * and tells us afterwards -- `onDidCloseTerminal`, then
 * `TerminalLifecycleService._noteDeliberateClose` -- and there is no event
 * before the fact for a dialog to stand in. The owner met that as a defect the
 * same day: "нажимаю на таб закрытия терминала - нет сообщения предупреждения о
 * закрытии терминала - ошибка".
 *
 * **Why an offer rather than a rule.** The record's fate turns on which hand
 * closed it (see `ClosedBy`), and the platform will not say: `exitStatus.reason`
 * is `User` for one cross and for `workbench.action.closeAllEditors` alike
 * (A29), and `window.tabGroups.onDidChangeTabs` fires once per tab for the bulk
 * gesture, five milliseconds apart -- the shape of a person closing two tabs by
 * hand. A build that guessed would either leave every record the owner wanted
 * gone, or hand one keystroke the whole store. So it asks, and the owner took
 * the price in those words: five tabs, five questions.
 *
 * **Here rather than in the command, and for the reason `restoreNotice` and
 * `forgottenNotice` are here:** what is said, and what silence means, is a
 * decision -- and a decision belongs where it can be read without a running
 * editor.
 */

/**
 * The word that brings the conversation back. A verb, like the other one.
 *
 * It does not merely dismiss: it takes the close off the record (`reopened`),
 * so a window that opens this project again starts that conversation. Pressing
 * nothing is the dismissal, and it is a different outcome.
 */
export const BRING_IT_BACK = 'Bring It Back';

/**
 * The word that destroys, and it says what it does.
 *
 * `close-terminal.ts` states the rule this obeys -- "the word this is confirmed
 * by; it says what happens, not 'yes'" -- and this is the button it matters
 * most for: what follows it is a record swept out of the store at the next
 * activation, with only the trash behind it.
 */
export const END_IT_FOR_GOOD = 'End It For Good';

/**
 * The three outcomes, and the third one is not a variation of the others.
 *
 * `no-answer` is a toast that timed out, an Escape, a person who never looked.
 * The editor reports all three the same way and none of them is somebody saying
 * "throw that conversation away".
 */
export type EditorCloseAnswer = 'bring-it-back' | 'end-it-for-good' | 'no-answer';

/**
 * The sentence, which carries what happens if it is ignored.
 *
 * A toast is dismissed far more often than it is pressed, so the outcome of
 * ignoring it is the outcome most people will get -- and a sentence that named
 * only the two buttons would leave that one unsaid.
 *
 * The name is in it because a window may have closed several at once: the
 * gesture that produces five of these produces five different records, and a
 * person answering the third has to know which conversation they are answering
 * about.
 */
export function closedInTheEditorOffer(displayName: string): string {
  return (
    `Gripterm: "${displayName}" was closed in the editor. Its record stays in the list ` +
    'and will not start again by itself.'
  );
}

/**
 * What the person said, out of what the editor hands back.
 *
 * **A total answer to an untotal input, and that is the whole of it.** The
 * editor hands back the label that was pressed or `undefined`, and nothing
 * stops a later build adding a third button or renaming one of these. Every
 * value that is not one of the two words is `no-answer`, which is the outcome
 * whose mistake costs a row rather than a conversation (§III.8: the measure is
 * the price of the irreversible error).
 */
export function answerAfterClosing(pressed: string | undefined): EditorCloseAnswer {
  if (pressed === BRING_IT_BACK) {
    return 'bring-it-back';
  }
  return pressed === END_IT_FOR_GOOD ? 'end-it-for-good' : 'no-answer';
}
