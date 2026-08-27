import {
  BRING_IT_BACK,
  END_IT_FOR_GOOD,
  answerAfterClosing,
  closedInTheEditorOffer,
} from '../../packages/core/src/index';
import type { EditorCloseAnswer } from '../../packages/core/src/index';

/*
 * The owner's decision of 2026-08-27, in the place a decision belongs: what is
 * said to a person, and what their answer means, are read here without a
 * running editor -- the same rule `forgottenNotice` and `restoreNotice` follow.
 *
 * **What it is for.** The cross on the editor's own tab reaches no command of
 * ours: there is no event before the fact, so there can be no dialog before it.
 * What there can be is an offer AFTER it, and the owner chose that over a build
 * that guesses -- "пять вкладок - пять вопросов", the price named and taken.
 */
describe('the offer a close in the editor raises', () => {
  it('names the conversation, because a window may have closed several', () => {
    expect(closedInTheEditorOffer('auth-refactor')).toContain('auth-refactor');
  });

  it('says what happens if nobody answers, because that is the commonest answer', () => {
    // A toast is dismissed far more often than it is pressed, so the sentence
    // has to carry the outcome of ignoring it or the person is told nothing.
    expect(closedInTheEditorOffer('auth-refactor')).toMatch(/list/u);
  });

  it('gives both buttons a verb, so neither of them is "yes"', () => {
    // `close-terminal.ts`: "The word this is confirmed by. It says what happens,
    // not yes." The button that destroys is the one that must obey it.
    for (const word of [BRING_IT_BACK, END_IT_FOR_GOOD]) {
      expect(word).toMatch(/^[A-Z]/u);
      expect(word.split(' ').length).toBeGreaterThan(1);
    }
    expect(BRING_IT_BACK).not.toBe(END_IT_FOR_GOOD);
  });
});

describe('what an answer to that offer means', () => {
  it('brings the record back when the person asked for it back', () => {
    expect(answerAfterClosing(BRING_IT_BACK)).toBe<EditorCloseAnswer>('bring-it-back');
  });

  it('ends it for good when the person said so in those words', () => {
    expect(answerAfterClosing(END_IT_FOR_GOOD)).toBe<EditorCloseAnswer>('end-it-for-good');
  });

  /*
   * THE RULE THIS FUNCTION EXISTS FOR. A toast that goes away on its own, an
   * Escape, a person who never looked -- the editor answers `undefined` to all
   * three, and none of them is a person saying "throw that conversation away".
   * The default has to be the one whose mistake costs a row rather than a
   * conversation.
   */
  it.each([undefined, '', 'Yes', 'some button of another notification'])(
    'takes %p as no answer at all, which leaves the record as it is',
    (pressed) => {
      expect(answerAfterClosing(pressed)).toBe<EditorCloseAnswer>('no-answer');
    }
  );
});
