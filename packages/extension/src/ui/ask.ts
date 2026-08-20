import * as vscode from 'vscode';

/**
 * The modal questions this window puts to a person, and the one seam a suite
 * can answer them through.
 *
 * **Why a seam exists at all.** A modal in a headless run is a suite that HANGS
 * rather than one that fails -- the lesson `terminal-gateway.test.ts` learned
 * from the editor's own `confirmOnKill` -- and M3.13 measured that a suite
 * cannot replace `vscode.window` underneath this bundle: the object a suite
 * requires is not the object the extension calls. So the question goes through
 * one object, and the run answers it here rather than at a dialog nobody can
 * click.
 *
 * **What it is NOT.** It is not the place every modal in this build lives:
 * adoption, deletion, cleanup, resume and start-over still ask
 * `vscode.window` directly, and they can, because no suite executes them --
 * they are checked by where they appear rather than by what they do. This
 * carries the one question that stands in a road a suite drives down.
 *
 * `answerNext` is spent by the next question and by nothing else. A standing
 * "yes" would make every later modal of the same run invisible, which is the
 * failure mode of every test double that outlives its test.
 */
export class Asker {
  private readonly _asked: string[] = [];
  private _next: boolean | null = null;

  /** Every question this window has put, oldest first. What a suite reads instead of a screenshot. */
  public get asked(): readonly string[] {
    return [...this._asked];
  }

  /** The answer the next question takes instead of asking it. Spent once. */
  public answerNext(answer: boolean): void {
    this._next = answer;
  }

  /**
   * Asks, and says whether the person agreed.
   *
   * Anything but the button -- Cancel, Escape, the dialog closing -- is no,
   * which is the same rule the other confirmations of this build follow.
   */
  public async confirm(question: string, detail: string, word: string): Promise<boolean> {
    this._asked.push(question);
    const queued = this._next;
    if (queued !== null) {
      this._next = null;
      return queued;
    }
    const answer = await vscode.window.showWarningMessage(question, { modal: true, detail }, word);
    return answer === word;
  }
}
