import * as vscode from 'vscode';
import type {
  Disposable,
  LaunchLocation,
  TerminalExit,
  TerminalGateway,
  TerminalHandle,
  TerminalId,
  TerminalSpec,
} from '@gripterm/core';

/**
 * Our vocabulary against the editor's. Total over `LaunchLocation`, so a third
 * place would fail the build here rather than fall back to a default nobody
 * chose.
 */
const PLACES: Readonly<Record<LaunchLocation, vscode.TerminalLocation>> = {
  editor: vscode.TerminalLocation.Editor,
  panel: vscode.TerminalLocation.Panel,
};

/**
 * The `TerminalGateway` port on `vscode.window`.
 *
 * Three properties of the platform shape this file, and all three are measured
 * rather than assumed:
 *
 *   * `isTransient: true` on every terminal we create (A3). Our terminals are
 *     sessions, not scrollback: the editor must not revive one on reload, or a
 *     restored shell would sit there wearing the name of a conversation that is
 *     not running in it.
 *   * `onDidCloseTerminal` is a WINDOW-level event, not a per-terminal one, so
 *     the routing to a handle happens here. One subscription for every terminal
 *     we own, and it is disposed with the gateway.
 *   * `exitStatus.code` is `undefined` when the person closed the terminal and a
 *     number when the process exited. That distinction is the only thing
 *     separating a failed launch from a deliberate close (M1.12), so it travels
 *     through the port untouched rather than being flattened into a boolean.
 *
 * WHERE the terminal lands is decided here and not in the domain, because it is
 * a fact about this editor and about nothing else: the spec says what to run.
 * The default is the editor area (`gripterm.launch.location`), which removes the
 * panel's furniture -- its `TERMINAL / PORTS / PROBLEMS / OUTPUT` bar and its own
 * list of terminals -- and puts our display name on the tab. It is also the
 * carrier the roadmap already names for the workflow view of M5: the canvas is a
 * webview tab BESIDE the terminal, and a terminal that lives in the panel has no
 * beside.
 */
export class VsCodeTerminalGateway implements TerminalGateway, Disposable {
  private readonly _handles = new Map<string, VsCodeTerminalHandle>();
  private readonly _closeSubscription: vscode.Disposable;
  private readonly _location: LaunchLocation;

  constructor(location: LaunchLocation) {
    this._location = location;
    this._closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      this._onClosed(terminal);
    });
  }

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const terminal = vscode.window.createTerminal({
      name: spec.name,
      cwd: spec.cwd,
      env: { ...spec.env },
      shellArgs: [...spec.shellArgs],
      location: PLACES[this._location],
      isTransient: true,
      // `null` means "run the person's own shell" (`gripterm.launch.mode:
      // shell`), and the editor spells that by the key being ABSENT. Writing
      // `shellPath: undefined` is a different thing under
      // `exactOptionalPropertyTypes` and does not compile -- which is the
      // compiler catching the exact confusion this spread avoids.
      ...(spec.shellPath === null ? {} : { shellPath: spec.shellPath }),
    });

    const handle = new VsCodeTerminalHandle(spec.terminalId, terminal);
    this._handles.set(spec.terminalId.value, handle);
    return handle;
  }

  public listKnown(): readonly TerminalHandle[] {
    return [...this._handles.values()];
  }

  /** The handle for a terminal we created, or `undefined` once it has closed. */
  public handleFor(terminalId: TerminalId): TerminalHandle | undefined {
    return this._handles.get(terminalId.value);
  }

  public dispose(): void {
    this._closeSubscription.dispose();
    // The terminals themselves are NOT disposed. Deactivation is not a reason
    // to kill a conversation, and the editor closing takes them anyway --
    // that is what `isTransient` is for.
    this._handles.clear();
  }

  private _onClosed(terminal: vscode.Terminal): void {
    for (const [id, handle] of this._handles) {
      if (handle.owns(terminal)) {
        // Forgotten BEFORE the listeners run, so that a listener asking
        // `listKnown()` -- which is what the attention notifier does to decide
        // whether there is still a terminal to show -- gets the answer that is
        // true after the close rather than the one that was true before it.
        this._handles.delete(id);
        handle.closed({ code: terminal.exitStatus?.code });
        return;
      }
    }
  }
}

class VsCodeTerminalHandle implements TerminalHandle {
  public readonly terminalId: TerminalId;

  private readonly _terminal: vscode.Terminal;
  private readonly _listeners = new Set<(exit: TerminalExit) => void>();

  constructor(terminalId: TerminalId, terminal: vscode.Terminal) {
    this.terminalId = terminalId;
    this._terminal = terminal;
  }

  public sendText(text: string, execute: boolean): void {
    this._terminal.sendText(text, execute);
  }

  public show(preserveFocus: boolean): void {
    this._terminal.show(preserveFocus);
  }

  public dispose(): void {
    this._terminal.dispose();
  }

  public onDidClose(listener: (exit: TerminalExit) => void): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  public owns(terminal: vscode.Terminal): boolean {
    return this._terminal === terminal;
  }

  public closed(exit: TerminalExit): void {
    for (const listener of this._listeners) {
      listener(exit);
    }
    this._listeners.clear();
  }
}
