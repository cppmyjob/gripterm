import * as vscode from 'vscode';
import { CLOSE_TERMINAL_COMMAND } from '../commands/close-terminal';
import { TerminalId, reorderTerminals, stripTabs } from '@gripterm/core';
import type { Logger, SessionRegistry, StripTab } from '@gripterm/core';
import type { TerminalStage } from './terminal-stage';
import type { ViewMessage } from '@gripterm/webview';
import type { WorkbenchView } from './workbench-view';

/**
 * The strip of tabs: what the panel holds, drawn, and what a click on one means.
 *
 * It sits between three things that already exist and adds no state of its own,
 * which is the whole design. The STAGE knows which terminals the panel holds,
 * which is on screen and which still have a process. The REGISTRY knows what
 * each of them is called and what it is doing. `stripTabs` in the core turns the
 * two into a strip -- through `presentTerminal`, the same rule the tree draws
 * its rows with, so a terminal cannot look like one thing in the list and
 * another on its tab.
 *
 * **Both clicks are wishes and neither is an act.** A click on a tab becomes one
 * more caller of `shown`, because which terminal is on screen is one answer
 * owned by the stage. A click on a cross becomes `gripterm.closeTerminal`, and
 * that is a rule rather than tidiness: closing writes `closedAt`, which is the
 * mark that keeps a record from ever coming back (§4.2), and a strip that
 * disposed of a terminal itself would have gone round the one place that
 * decision lives.
 *
 * The cross does two different things and says so: a RUNNING terminal is closed
 * -- the process ends, the record is marked, and the command asks the person
 * first (M3.14) -- while one whose process has already gone is only taken off
 * the strip, with no question at all. The second half is the reversible one and
 * it is deliberately so: an agent that died on its own may still be worth
 * resuming, and `closedAt` would take that away for good in order to tidy a tab.
 */

export interface TerminalStripOptions {
  readonly view: WorkbenchView;
  readonly stage: TerminalStage;
  readonly registry: SessionRegistry;
  readonly logger: Logger;
}

export class TerminalStrip implements vscode.Disposable {
  private readonly _options: TerminalStripOptions;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _refusals: string[] = [];
  private _drawn: readonly StripTab[] = [];

  constructor(options: TerminalStripOptions) {
    this._options = options;
    this._subscriptions.push(
      options.view.onMessage((message) => { this._heard(message); }),
      options.stage.onChanged(() => { this._draw(); }),
      // The names and the states, which live nowhere in the panel: a terminal
      // renamed from the CLI, or one that has just started waiting for
      // permission, changes nothing the stage can see.
      options.registry.subscribe(() => { this._draw(); })
    );
  }

  /** The strip as this window last drew it. What the suite reads instead of a screenshot. */
  public get tabs(): readonly StripTab[] {
    return this._drawn;
  }

  /** Everything the strip refused to do, in its own words. */
  public get refusals(): readonly string[] {
    return this._refusals;
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
  }

  private _draw(): void {
    const { stage, registry, view } = this._options;
    this._drawn = stripTabs({
      held: stage.held,
      running: stage.running,
      active: stage.activeTerminal,
      // This window's own records only. The panel holds this window's own
      // terminals, and a record projected in from another window has nothing on
      // this strip to be about.
      entries: registry.own(),
    });
    view.post({ kind: 'tabs', tabs: this._drawn });
  }

  private _heard(message: ViewMessage): void {
    if (message.kind === 'chose') {
      this._chose(message.terminalId);
      return;
    }
    if (message.kind === 'wants-close') {
      this._close(message.terminalId);
      return;
    }
    if (message.kind === 'reorder') {
      this._reorder(message.terminalId, message.toIndex);
    }
  }

  /**
   * The person dragged a tab somewhere (owner's decision 2026-08-21).
   *
   * Applied over THE LIST THE PAGE WAS LOOKING AT and not over everything this
   * window holds, which is the one thing that could go wrong here quietly: the
   * index arrives counted in tabs, and a record with no tab -- a terminal taken
   * off the strip whose record is still here -- would shift every number by one
   * and move the wrong terminal.
   *
   * Nothing is written from here. `amend` publishes and `BaseWriter` stores
   * (M2.6), which is the one road from a change to the disk, and it is what
   * makes a drag survive a store that is unreachable for a moment.
   */
  private _reorder(terminalId: string, toIndex: number): void {
    const moved = this._named(terminalId, 'dragged');
    if (moved === null) {
      return;
    }
    const { registry, logger } = this._options;
    const drawn = new Set(this._drawn.map((tab) => tab.terminalId));
    const changed = reorderTerminals({
      entries: registry.own().filter((entry) => drawn.has(entry.terminalId.value)),
      moved,
      toIndex,
    });
    for (const entry of changed) {
      registry.amend(entry);
    }
    logger.info('a tab was dragged', {
      terminalId,
      toIndex,
      // Zero when the tab was let go where it already was, one for an ordinary
      // move, and more than one only when the arrangement had run out of room
      // between two neighbours and was written out again (`reorderTerminals`).
      records: changed.length,
    });
  }

  private _chose(terminalId: string): void {
    const named = this._named(terminalId, 'chosen');
    if (named === null) {
      return;
    }
    // `false`: somebody clicked a tab asking to be taken to that terminal, and
    // leaving the keyboard where it was would be answering another question.
    this._options.stage.shown(named, false);
  }

  private _close(terminalId: string): void {
    if (this._named(terminalId, 'closed') === null) {
      return;
    }
    if (!this._options.stage.isRunning(terminalId)) {
      // Nothing to end: the tab of a terminal whose process is gone leaves, and
      // the record is left alone -- the reversible half (§I.3).
      this._options.stage.removed(terminalId);
      return;
    }
    void this._end(terminalId);
  }

  /**
   * A cross on a LIVE terminal: the command decides, and the tab follows it.
   *
   * Waited on rather than fired and forgotten, and that is the whole of M3.14
   * here: the command asks the person whether to end the conversation, and a
   * strip that took the tab away meanwhile would answer for them -- an agent
   * still running with no tab to reach it by.
   */
  private async _end(terminalId: string): Promise<void> {
    // With the id as its argument so that it acts on the tab that was clicked
    // rather than asking which terminal was meant.
    const closed = await vscode.commands.executeCommand<boolean>(CLOSE_TERMINAL_COMMAND, terminalId);
    if (closed) {
      this._options.stage.removed(terminalId);
    }
  }

  /** The id, or a refusal said aloud: a click naming nothing is a defect of ours. */
  private _named(terminalId: string, what: string): TerminalId | null {
    const named = TerminalId.tryFromString(terminalId);
    if (named === null) {
      const refusal = `the strip named something that is not a terminal when one was ${what}: ${terminalId}`;
      this._refusals.push(refusal);
      this._options.logger.warn('the panel named something that is not a terminal', { terminalId, what });
      return null;
    }
    return named;
  }
}
