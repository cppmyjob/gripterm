// Types only, and that is what the linter is asking for rather than a style
// preference: nothing here calls the editor. Every editor act this class needs
// belongs to the view it is given, which is the object that owns the panel.
import type * as vscode from 'vscode';
import { TerminalBridge } from './terminal-bridge';
import type { Logger, Scheduler, TerminalAudience, TerminalHandle, TerminalId } from '@gripterm/core';
import type { HostMessage, ViewMessage } from '@gripterm/webview';
import type { WorkbenchView } from './workbench-view';

/**
 * Which terminals the panel is holding, which of them is on screen, and
 * everything that follows from those being ONE answer each.
 *
 * The plan asks for this by name: "the owner of the state 'active terminal' is
 * one named object in the composition root". It is one object because the
 * question is asked from five directions that cannot see each other -- a person
 * pressing "new terminal", a window restoring six of them at start-up, a page
 * that was rebuilt and knows nothing, a panel being hidden and shown, and since
 * M3.9 a person clicking a tab -- and every one of them would otherwise keep its
 * own idea of what is on screen.
 *
 * **What it owns:** a bridge per terminal of ours (each with its own tail, so
 * nothing an unwatched agent prints is lost), the ORDER they were taken in,
 * which of them the screen is showing, and the handshake with the page.
 *
 * **What it does not own:** the bytes (that is `TerminalBridge`), the channel
 * (that is `WorkbenchView`), and how the strip looks (that is `TerminalStrip`,
 * over `stripTabs` in the core).
 *
 * **Every terminal is attached at once, since M3.9.** The page keeps one live
 * xterm per terminal, so output goes to all of them while the panel is open and
 * a switch is a change of what is visible and nothing more. What used to be
 * "attach the active one and detach the rest" is now one question -- is the
 * panel visible -- asked of every bridge together.
 */

/**
 * How long a person waits for the panel before their launch is refused.
 *
 * The lesson of M2.16 turned into a number: a script that did not come up --
 * blocked by the content policy, or pointed at a resource that is not in the
 * package -- would leave `claude` running where nobody can see it, answering
 * nothing and costing a real conversation. So a MANUAL launch waits for the page
 * and refuses out loud if it does not arrive.
 *
 * Five seconds rather than the twenty this channel allows elsewhere: this one is
 * spent in front of a person who has just pressed a button, and a page that has
 * not loaded in five seconds is not loading. A restore does not wait at all --
 * see `shown`, which reveals without taking the focus.
 */
export const LAUNCH_WAIT_MS = 5_000;

export interface TerminalStageOptions {
  readonly view: WorkbenchView;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
}

export class TerminalStage implements TerminalAudience, vscode.Disposable {
  private readonly _options: TerminalStageOptions;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _bridges = new Map<string, TerminalBridge>();
  /**
   * The order the panel took them in, which is the order of the strip.
   *
   * Kept beside the bridges rather than read off them: a `Map` does keep its
   * insertion order, but a terminal removed and taken again would move to the
   * end of it, and a tab that jumps while somebody is aiming at it is the one
   * thing a strip may not do.
   */
  private readonly _held: string[] = [];
  private readonly _refusals: string[] = [];
  /** Terminals the page has been given a screen for. */
  private readonly _attached = new Set<string>();
  private readonly _watchers = new Set<() => void>();
  private readonly _sink: (message: HostMessage) => void;
  /** The terminal that should be on screen, by the owner's rule: whoever was last asked for. */
  private _active: string | null = null;
  /** The terminal the PAGE is showing, which is not the same thing until they are synchronised. */
  private _showing: string | null = null;
  private _pageIsUp = false;

  constructor(options: TerminalStageOptions) {
    this._options = options;
    this._sink = (message): void => { options.view.post(message); };
    this._subscriptions.push(
      options.view.onMessage((message) => { this._heard(message); }),
      options.view.onVisibility((visible) => { this._visibility(visible); })
    );
  }

  /** The terminal that should be on screen, or `null` when there is none. */
  public get activeTerminal(): string | null {
    return this._active;
  }

  /** The terminal the page is really showing. Equal to the active one once they have met. */
  public get attachedTerminal(): string | null {
    return this._showing;
  }

  /** Every terminal the panel is holding, in the order it took them. */
  public get held(): readonly string[] {
    return [...this._held];
  }

  /** Those of them that still have a process. The rest are kept to be read. */
  public get running(): readonly string[] {
    return this._held.filter((terminalId) => this.isRunning(terminalId));
  }

  /** Everything this stage refused to do, in its own words. Kept for the suite and the log. */
  public get refusals(): readonly string[] {
    return this._refusals;
  }

  /** Whether this terminal's process is still there. A held terminal that has ended is not. */
  public isRunning(terminalId: string): boolean {
    const bridge = this._bridges.get(terminalId);
    return bridge !== undefined && !bridge.over;
  }

  /** One terminal's bridge, for a suite that wants the numbers rather than the picture. */
  public bridgeFor(terminalId: string): TerminalBridge | undefined {
    return this._bridges.get(terminalId);
  }

  /**
   * When what the strip is drawn from changes: which terminals are held, which
   * is active, whether one has ended.
   *
   * An event rather than a call into a presenter, so that this class stays
   * ignorant of how a tab looks -- and so that the composition root can wire a
   * window without a strip at all, which is what every suite that only wants
   * bytes does.
   */
  public onChanged(watcher: () => void): vscode.Disposable {
    this._watchers.add(watcher);
    return { dispose: (): void => { this._watchers.delete(watcher); } };
  }

  /**
   * A terminal of ours exists and has bytes: start keeping them at once.
   *
   * From this instant, whether or not anybody is looking. Output that arrived
   * before the first glance at the panel is exactly the output that says why a
   * launch failed, and a bridge built later would have missed it.
   *
   * The first terminal also takes the screen. Not a rule about newness -- the
   * owner's rule is "whoever was last asked for" -- but the answer to a screen
   * that has nothing on it at all: a window whose only agent never called `show`
   * would otherwise run it behind an empty panel.
   */
  public opened(handle: TerminalHandle): void {
    const terminalId = handle.terminalId.value;
    const screen = handle.screen;
    if (screen === undefined) {
      // The `editor` engine, whose terminals have no bytes to be had (§4.1). Not
      // an error: this stage simply has nothing to do with them.
      this._options.logger.info('a terminal without a screen was opened, so the panel has nothing to show for it', {
        terminalId,
      });
      return;
    }
    const bridge = new TerminalBridge({
      terminalId,
      screen,
      scheduler: this._options.scheduler,
      logger: this._options.logger,
      ended: (because) => { this._ended(terminalId, because); },
    });
    this._bridges.set(terminalId, bridge);
    if (!this._held.includes(terminalId)) {
      this._held.push(terminalId);
    }
    this._active ??= terminalId;
    this._settle();
  }

  /**
   * Somebody asked for this terminal to be the one on screen.
   *
   * `preserveFocus` travels straight through to the view, and the difference it
   * carries is П7: a window bringing six terminals back must not take the
   * person's cursor six times, while a person who pressed "new terminal" is
   * asking for exactly that.
   *
   * The strip is one more caller of this and not a second copy of the state --
   * which is what keeps a click on a tab, a notification's button and a restore
   * from ever disagreeing about what is in front of the person.
   */
  public shown(terminalId: TerminalId, preserveFocus: boolean): void {
    this._active = terminalId.value;
    this._options.view.reveal(preserveFocus);
    this._settle();
  }

  /**
   * The person clicked the cross on a tab: this terminal leaves the panel.
   *
   * Only the PANEL. Whether the record is closed as well is the caller's
   * decision and it goes through `gripterm.closeTerminal`, which is the one
   * place `closedAt` is written -- a screen that disposed of a terminal itself
   * would have gone round the rule that a closed terminal does not come back
   * (§4.2, `terminal-lifecycle.ts`).
   *
   * The neighbour takes the screen, and it is the tab BEFORE this one: a person
   * closing several in a row would otherwise walk forwards through terminals
   * they have not looked at.
   */
  public removed(terminalId: string): void {
    const at = this._held.indexOf(terminalId);
    if (at < 0) {
      return;
    }
    this._held.splice(at, 1);
    this._bridges.get(terminalId)?.dispose();
    this._bridges.delete(terminalId);
    this._attached.delete(terminalId);
    if (this._active === terminalId) {
      this._active = this._held[at - 1] ?? this._held[at] ?? null;
    }
    if (this._showing === terminalId) {
      this._showing = null;
    }
    this._settle();
  }

  /**
   * Brings the panel up and waits for its page, or says why it did not come.
   *
   * `null` means the page is up. Anything else is a sentence for a person, and
   * the caller's job is to say it and NOT start an agent -- see M2.16 for what a
   * conversation running where nobody can see it costs.
   */
  public async whenPageIsUp(timeoutMs: number = LAUNCH_WAIT_MS): Promise<string | null> {
    this._options.view.reveal(false);
    try {
      await this._options.view.whenReady(timeoutMs);
      return null;
    } catch (cause: unknown) {
      const what = 'the Gripterm panel did not come up, so no agent was started — it would have run where you cannot see it';
      this._refusals.push(what);
      this._options.logger.error('the panel did not come up in time, so a launch was refused', {
        cause,
        waitedMs: timeoutMs,
      });
      return what;
    }
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
    this._watchers.clear();
    for (const bridge of this._bridges.values()) {
      bridge.dispose();
    }
    this._bridges.clear();
    this._held.length = 0;
  }

  private _heard(message: ViewMessage): void {
    switch (message.kind) {
      case 'ready':
        // The rehydration handshake, and the reason `ready` is not only a
        // start-up gate: a page that was thrown away and rebuilt has empty
        // screens and no idea which agents it belongs to. It holds nothing until
        // we give it something.
        this._pageIsUp = true;
        this._attached.clear();
        this._showing = null;
        this._settle();
        return;
      case 'ack':
        this._bridge(message.terminalId)?.acknowledged(message.chars);
        return;
      case 'input':
        this._bridge(message.terminalId)?.type(message.data);
        return;
      case 'resized':
        this._bridge(message.terminalId)?.resize(message.cols, message.rows);
        return;
      default:
        return;
    }
  }

  private _visibility(visible: boolean): void {
    if (!visible) {
      // Every one of them, and unconditionally: a hidden webview keeps its page
      // but Chromium clamps its timers, so receipts stop arriving and a pause
      // would never lift. A bridge that was already detached is unmoved by it.
      for (const bridge of this._bridges.values()) {
        bridge.hide();
      }
      return;
    }
    if (!this._pageIsUp) {
      return;
    }
    for (const terminalId of this._held) {
      const bridge = this._bridges.get(terminalId);
      if (bridge === undefined) {
        continue;
      }
      if (!this._attached.has(terminalId)) {
        continue;
      }
      const redrawn = bridge.resume(this._sink);
      if (redrawn) {
        // Worth a line: the person's scroll position and selection are gone, and
        // this says why rather than leaving them to wonder.
        this._options.logger.info('a terminal printed more while the panel was hidden than is kept, so its screen was redrawn', {
          terminalId,
        });
      }
    }
    this._settle();
  }

  /**
   * Gives the page a screen for every terminal it has none for.
   *
   * All of them and not only the active one: a screen that took output only
   * while it was in front would have to be replayed on every switch, which is
   * the scrollback, the selection and the TUI redrawn each time -- the cost
   * M3.9 exists to remove.
   */
  private _sync(): void {
    if (!this._pageIsUp || !this._options.view.visible) {
      return;
    }
    for (const terminalId of this._held) {
      if (this._attached.has(terminalId)) {
        continue;
      }
      const bridge = this._bridges.get(terminalId);
      if (bridge === undefined) {
        this._options.logger.warn('the panel is holding a terminal with no bridge behind it', { terminalId });
        continue;
      }
      bridge.attach(this._sink);
      this._attached.add(terminalId);
    }
    this._showing = this._active !== null && this._attached.has(this._active) ? this._active : null;
  }

  /**
   * The process behind one terminal has gone.
   *
   * The screen and the tab STAY -- the owner's decision of 2026-08-18 -- and so
   * does the bridge, because the bridge is where the tail lives: a page rebuilt
   * after the process ended would otherwise come back with an empty screen under
   * a tab whose whole purpose is the last thing the agent said. What goes is the
   * process, and `detach` is what writes that on the screen.
   */
  private _ended(terminalId: string, because: string): void {
    if (this._attached.has(terminalId)) {
      this._sink({ kind: 'detach', terminalId, because });
    }
    this._changed();
  }

  /**
   * The strip first, the screens after it.
   *
   * The order is a measurement rather than a preference (2026-08-18): the strip
   * takes its height out of the terminal's, so a screen made BEFORE the tab that
   * pushes it down is fitted to a box it is about to lose a row of -- and its pty
   * is then told two sizes in a row. ConPTY announces only the first of those in
   * the output stream, so the agent's own first frame is drawn at a height
   * nothing is going to keep.
   */
  private _settle(): void {
    this._changed();
    this._sync();
  }

  private _changed(): void {
    for (const watcher of this._watchers) {
      watcher();
    }
  }

  private _bridge(terminalId: string): TerminalBridge | undefined {
    const found = this._bridges.get(terminalId);
    if (found === undefined) {
      this._options.logger.warn('the panel spoke about a terminal this window is not holding', { terminalId });
    }
    return found;
  }
}
