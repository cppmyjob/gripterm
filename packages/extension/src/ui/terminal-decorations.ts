import * as vscode from 'vscode';
import { TerminalId, presentTerminal } from '@gripterm/core';
import type { Disposable, SessionRegistry } from '@gripterm/core';

/**
 * A scheme of our own, so that nothing else in the editor answers for these.
 *
 * It names no file and is never opened. A tree item carries a `resourceUri`
 * purely so that decorations have something to attach to, which is the only way
 * the platform offers to colour a row's LABEL -- see `TerminalPresentation`.
 */
const DECORATION_SCHEME = 'gripterm-terminal';

/** The identity a decoration is asked about. `gripterm-terminal:/<terminalId>`. */
export function terminalUri(terminalId: TerminalId): vscode.Uri {
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${terminalId.value}` });
}

/**
 * The person's colour, on the row's label.
 *
 * Why this exists at all rather than the colour simply going on the icon: the
 * icon's colour is the answer to "does this one need me", which is the question
 * П1 is about, and a personal colour laid over it would trade the row's only
 * automatic signal for a manual one -- quietly, and only for the people who used
 * the feature. Two colours, two surfaces, one decision, and it is stated in
 * `TerminalPresentation` where a test can reach it.
 *
 * The refresh carries no delta, for the same reason the tree's does not: the
 * signal says "ask again". Firing `undefined` asks about every row, which for a
 * list of this size is cheaper than being wrong about which row moved.
 */
export class TerminalDecorationProvider implements vscode.FileDecorationProvider, Disposable {
  public readonly onDidChangeFileDecorations: vscode.Event<undefined>;

  private readonly _registry: SessionRegistry;
  private readonly _changed = new vscode.EventEmitter<undefined>();
  private readonly _subscription: Disposable;

  constructor(registry: SessionRegistry) {
    this._registry = registry;
    this.onDidChangeFileDecorations = this._changed.event;
    this._subscription = registry.subscribe(() => {
      this._changed.fire(undefined);
    });
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) {
      return undefined;
    }
    // `tryFromString` rather than a cast: the platform may ask about a uri we
    // did not mint, and a wrong terminal is worse than none.
    const terminalId = TerminalId.tryFromString(uri.path.slice(1));
    if (terminalId === null) {
      return undefined;
    }

    const entry = this._registry.list().find((held) => held.terminalId.equals(terminalId));
    if (entry === undefined) {
      return undefined;
    }
    const { labelColorId } = presentTerminal(entry);
    // No badge and no tooltip. Both belong to the row, the row already has
    // them, and a decoration that repeated either would put the same sentence
    // on screen twice.
    return labelColorId === null
      ? undefined
      : new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(labelColorId));
  }

  public dispose(): void {
    this._subscription.dispose();
    this._changed.dispose();
  }
}
