import * as vscode from 'vscode';

/**
 * The lists this window puts in front of a person, and the one seam a run can
 * answer them through.
 *
 * **Why a seam exists at all**, and it is the same argument `Asker` makes about
 * modals, met one door further along. A quick pick in a headless run is a suite
 * that HANGS rather than one that fails, and M3.13 measured that a suite cannot
 * replace `vscode.window` underneath this bundle: the object a suite requires is
 * not the object the extension calls. So the list goes through one object, and
 * the run answers it here.
 *
 * **What it is NOT.** It is not where every picker in this build lives: the
 * terminal pickers still call `vscode.window.showQuickPick` directly, and they
 * can, because what they choose between is a row a person is already looking at.
 * This carries the one list whose CONTENT is the promise -- what is in the trash
 * and what putting it back would do -- and whose act writes into the store.
 *
 * `chooseNext` is spent by the next list and by nothing else, for the reason
 * `Asker.answerNext` is: a standing answer makes every later list of the same
 * run invisible.
 */
export class Picker {
  private readonly _offered: (readonly string[])[] = [];
  private _next: { readonly label: string } | { readonly dismissed: true } | null = null;

  /** Every list this window has offered, oldest first, as the labels a person saw. */
  public get offered(): readonly (readonly string[])[] {
    return [...this._offered];
  }

  /** The label the next list is answered with instead of being shown. Spent once. */
  public chooseNext(label: string): void {
    this._next = { label };
  }

  /**
   * Walks away from the next list without choosing, which is Escape.
   *
   * Its own method rather than a `null` through `chooseNext`, because the two
   * are different promises: one says which row, and this says that a person who
   * changed their mind changes nothing.
   */
  public chooseNothing(): void {
    this._next = { dismissed: true };
  }

  /**
   * Offers a list, and says what was chosen -- `undefined` for Escape and for a
   * dismissal, which is the same "no" every other refusal in this build takes.
   *
   * A queued answer that matches NOTHING throws rather than answering `undefined`.
   * It can only be reached by a run that asked for it, and the alternative is a
   * test that names a label this list no longer offers and passes in silence.
   */
  public async pick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions
  ): Promise<T | undefined> {
    this._offered.push(items.map((item) => item.label));
    const queued = this._next;
    if (queued === null) {
      return await vscode.window.showQuickPick(items, options);
    }

    this._next = null;
    if ('dismissed' in queued) {
      return undefined;
    }
    const chosen = items.find((item) => item.label === queued.label);
    if (chosen === undefined) {
      throw new Error(
        `this list does not offer "${queued.label}"; it offers ${JSON.stringify(items.map((item) => item.label))}`
      );
    }
    return chosen;
  }
}
