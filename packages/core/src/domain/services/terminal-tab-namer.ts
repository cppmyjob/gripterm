import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { TerminalGateway, TerminalHandle } from '../ports/terminal-gateway';

export interface TerminalTabNamerOptions {
  readonly registry: SessionRegistry;
  readonly gateway: TerminalGateway;
  readonly logger: Logger;
}

/**
 * The editor's tab, kept on the same name as the row.
 *
 * It exists because there are now two ways a name changes -- `Gripterm: Rename
 * Terminal`, and `/rename` typed inside the terminal itself (M2.17) -- and a tab
 * that followed only one of them would be a tab that is right half the time,
 * which is worse than one that is never right.
 *
 * One seam for both, and the seam is the record: everything that renames a
 * terminal amends the registry, so this hears about all of it without knowing
 * that any of it exists. What it does NOT do is invent a name; it only carries
 * one that something else decided.
 *
 * **A name is applied when it CHANGES, and the first one is never applied.** A
 * terminal is created with the record's display name already on it (`TerminalSpec.name`),
 * so renaming it to what it is called would be a command sent to the editor for
 * nothing -- and that command, on this platform, has to make the terminal active
 * first (see the gateway). The first sighting of a record is therefore
 * remembered and not acted on.
 */
export class TerminalTabNamer implements Disposable {
  private readonly _options: TerminalTabNamerOptions;
  /** Terminal id -> the name its tab is believed to carry. */
  private readonly _applied = new Map<string, string>();
  private readonly _subscription: Disposable;

  constructor(options: TerminalTabNamerOptions) {
    this._options = options;
    this._subscription = options.registry.subscribe((change: RegistryChange) => {
      this._onChange(change);
    });
  }

  public dispose(): void {
    this._subscription.dispose();
    this._applied.clear();
  }

  private _onChange(change: RegistryChange): void {
    if (change.kind === 'removed') {
      this._applied.delete(change.terminalId.value);
      return;
    }
    // Only our own records have a tab in this window. A record another window
    // owns is drawn in the list and belongs to a terminal that is not here.
    if (change.kind !== 'entry') {
      return;
    }

    const id = change.entry.terminalId.value;
    const name = change.entry.metadata.displayName;
    const handle = this._handleFor(id);
    if (handle === undefined) {
      // The terminal has closed and the record has not caught up yet, or this
      // record was projected in before its terminal existed. Neither is an
      // error: there is no tab to name.
      return;
    }

    const applied = this._applied.get(id);
    this._applied.set(id, name);
    if (applied === undefined || applied === name) {
      return;
    }
    handle.rename(name);
    this._options.logger.info('a terminal tab was renamed to follow its row', {
      terminalId: id,
      was: applied,
      now: name,
    });
  }

  /**
   * `listKnown` rather than a lookup of our own: the gateway already answers
   * exactly this question, and the port is the place where "which terminals does
   * this window have" is defined once. The list is the open terminals of one
   * window -- a handful.
   */
  private _handleFor(id: string): TerminalHandle | undefined {
    return this._options.gateway.listKnown().find((handle) => handle.terminalId.value === id);
  }
}
