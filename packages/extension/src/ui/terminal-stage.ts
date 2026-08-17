// Types only, and that is what the linter is asking for rather than a style
// preference: nothing here calls the editor. Every editor act this class needs
// belongs to the view it is given, which is the object that owns the panel.
import type * as vscode from 'vscode';
import { TerminalBridge } from './terminal-bridge';
import type { Logger, Scheduler, TerminalAudience, TerminalHandle, TerminalId } from '@gripterm/core';
import type { HostMessage, ViewMessage } from '@gripterm/webview';
import type { WorkbenchView } from './workbench-view';

/**
 * Which terminal the panel is showing, and everything that follows from that
 * being ONE answer.
 *
 * The plan asks for this by name: "the owner of the state 'active terminal' is
 * one named object in the composition root". It is one object because the
 * question is asked from four directions that cannot see each other -- a person
 * pressing "new terminal", a window restoring six of them at start-up, a page
 * that was rebuilt and knows nothing, and a panel being hidden and shown -- and
 * every one of them would otherwise keep its own idea of what is on screen.
 *
 * **What it owns:** a bridge per terminal of ours (each with its own tail, so
 * nothing an unwatched agent prints is lost), which of them the screen is
 * showing, and the handshake with the page.
 *
 * **What it does not own:** the bytes (that is `TerminalBridge`), the channel
 * (that is `WorkbenchView`), and the choice of terminal in M3.9's strip -- which
 * will arrive as one more caller of `shown`, not as a second copy of this state.
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
  private readonly _refusals: string[] = [];
  private readonly _sink: (message: HostMessage) => void;
  /** The terminal that should be on screen, by the owner's rule: whoever was last asked for. */
  private _active: string | null = null;
  /** The terminal the PAGE is holding, which is not the same thing until they are synchronised. */
  private _attached: string | null = null;
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
    return this._attached;
  }

  /** Everything this stage refused to do, in its own words. Kept for the suite and the log. */
  public get refusals(): readonly string[] {
    return this._refusals;
  }

  /** One terminal's bridge, for a suite that wants the numbers rather than the picture. */
  public bridgeFor(terminalId: string): TerminalBridge | undefined {
    return this._bridges.get(terminalId);
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
    this._active ??= terminalId;
    this._sync();
  }

  /**
   * Somebody asked for this terminal to be the one on screen.
   *
   * `preserveFocus` travels straight through to the view, and the difference it
   * carries is П7: a window bringing six terminals back must not take the
   * person's cursor six times, while a person who pressed "new terminal" is
   * asking for exactly that.
   */
  public shown(terminalId: TerminalId, preserveFocus: boolean): void {
    this._active = terminalId.value;
    this._options.view.reveal(preserveFocus);
    this._sync();
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
        reason: String(cause),
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
    for (const bridge of this._bridges.values()) {
      bridge.dispose();
    }
    this._bridges.clear();
  }

  private _heard(message: ViewMessage): void {
    switch (message.kind) {
      case 'ready':
        // The rehydration handshake, and the reason `ready` is not only a
        // start-up gate: a page that was thrown away and rebuilt has an empty
        // screen and no idea which agent it belongs to. It holds nothing until
        // we give it something.
        this._pageIsUp = true;
        this._attached = null;
        this._sync();
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
      // Every one of them, not only the attached one: this is the unconditional
      // release, and a bridge that was already detached is unmoved by it.
      for (const bridge of this._bridges.values()) {
        bridge.hide();
      }
      return;
    }
    const active = this._active;
    if (active === null || active !== this._attached || !this._pageIsUp) {
      this._sync();
      return;
    }
    const bridge = this._bridges.get(active);
    if (bridge === undefined) {
      return;
    }
    const redrawn = bridge.resume(this._sink);
    if (redrawn) {
      // Worth a line: the person's scroll position and selection are gone, and
      // this says why rather than leaving them to wonder.
      this._options.logger.info('a terminal printed more while the panel was hidden than is kept, so its screen was redrawn', {
        terminalId: active,
      });
    }
  }

  private _sync(): void {
    const active = this._active;
    if (active === null || !this._pageIsUp || !this._options.view.visible) {
      return;
    }
    if (this._attached === active) {
      return;
    }
    const bridge = this._bridges.get(active);
    if (bridge === undefined) {
      this._options.logger.warn('the panel was asked to show a terminal this window is not holding', {
        terminalId: active,
      });
      return;
    }
    if (this._attached !== null) {
      // No `detach` message: the attach below resets the screen anyway, and a
      // detach would print a line the reset then wipes.
      this._bridges.get(this._attached)?.hide();
    }
    bridge.attach(this._sink);
    this._attached = active;
  }

  private _ended(terminalId: string, because: string): void {
    if (this._attached === terminalId) {
      // The screen keeps what the agent printed on its way out and says
      // underneath that it is over. Nothing is cleared: those last lines are the
      // whole of what a person has left to read.
      this._sink({ kind: 'detach', terminalId, because });
      this._attached = null;
    }
    this._bridges.get(terminalId)?.dispose();
    this._bridges.delete(terminalId);
    if (this._active === terminalId) {
      // Deliberately not replaced by another live terminal: choosing between
      // several is M3.9's strip, and a screen that jumped to an agent nobody
      // asked for would be answering a question nobody put.
      this._active = null;
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
