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
 * The only way an extension can rename a terminal it created.
 *
 * A command rather than an API, and one that names no target: it renames the
 * ACTIVE terminal. Read out of the 1.132 bundle -- `{id:
 * "workbench.action.terminal.renameWithArg", args: [{name: "args", schema:
 * {required: ["name"]}}], run: (instance, ..., args) => instance.rename(name)}`
 * -- and measured in a real host by the integration suite, because a command id
 * is not a contract and the next build may drop it.
 */
const RENAME_ACTIVE_TERMINAL = 'workbench.action.terminal.renameWithArg';

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
  private readonly _activeSubscription: vscode.Disposable;
  private readonly _location: LaunchLocation;

  constructor(location: LaunchLocation) {
    this._location = location;
    this._closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      this._onClosed(terminal);
    });
    // The other half of `rename`: a name that could not be applied when it
    // arrived is applied the moment the person turns to that terminal.
    this._activeSubscription = vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal === undefined) {
        return;
      }
      for (const handle of this._handles.values()) {
        if (handle.owns(terminal)) {
          handle.applyPendingName();
          return;
        }
      }
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
    this._activeSubscription.dispose();
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
  /** A name this terminal is to take as soon as it is the one being looked at. */
  private _pendingName: string | null = null;

  constructor(terminalId: TerminalId, terminal: vscode.Terminal) {
    this.terminalId = terminalId;
    this._terminal = terminal;
  }

  /**
   * `Terminal.processId` is a promise the editor settles once the process is
   * spawned, and `undefined` when it has none to report -- a terminal whose
   * process never came up, or one the platform lost track of. Both arrive here
   * as `null`: the record stores a pid or the absence of one, and inventing a
   * number would make the restore predicate ask whether a stranger is alive.
   */
  public async processId(): Promise<number | null> {
    return (await this._terminal.processId) ?? null;
  }

  public sendText(text: string, execute: boolean): void {
    this._terminal.sendText(text, execute);
  }

  public show(preserveFocus: boolean): void {
    this._terminal.show(preserveFocus);
  }

  /**
   * A new name on the tab.
   *
   * There is no API for it: `Terminal.name` is read-only and the editor exposes
   * renaming only as the command below, which -- read out of the 1.132 bundle
   * and confirmed in a real host -- takes `{name}` and applies it to the
   * ACTIVE terminal, whichever that is. So a rename of a terminal nobody is
   * looking at cannot be done at all without first making it active, and making
   * it active would move the panel under the person's hands for a cosmetic
   * change they did not ask for.
   *
   * It is therefore held and applied when the person turns to that terminal.
   * That is not a compromise about latency: the case this exists for is
   * `/rename` typed INSIDE a terminal (M2.17), and a terminal being typed into
   * is the active one, so the ordinary path renames immediately.
   */
  public rename(name: string): void {
    if (vscode.window.activeTerminal !== this._terminal) {
      this._pendingName = name;
      return;
    }
    this._pendingName = null;
    this._applyName(name);
  }

  /** The held name, once this terminal is the one in front of the person. */
  public applyPendingName(): void {
    const name = this._pendingName;
    if (name === null) {
      return;
    }
    this._pendingName = null;
    this._applyName(name);
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

  /**
   * The editor's own rename, asked for and not awaited.
   *
   * A rejection is swallowed on purpose: this runs from a registry change with
   * no caller behind it, the command is a command and not an API, and the whole
   * cost of it failing is a tab still wearing its old name beside a row that has
   * the new one. Throwing out of here would take down whatever change was being
   * announced.
   */
  private _applyName(name: string): void {
    void vscode.commands.executeCommand(RENAME_ACTIVE_TERMINAL, { name }).then(undefined, () => {
      // Nothing to do and nobody to tell. See above.
    });
  }
}
