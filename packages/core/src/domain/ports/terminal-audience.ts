import type { TerminalHandle } from './terminal-gateway';
import type { TerminalId } from '../entities/terminal-id';

/**
 * Whoever is going to SHOW a terminal, as the thing that makes one sees them.
 *
 * It exists because of a boundary rather than for elegance (§4.2). The engine
 * that owns the bytes lives in `packages/extension/src/adapters/` and may not
 * know the editor exists; the thing that draws them is a webview and is nothing
 * BUT the editor. Neither may import the other -- the linter refuses `node-pty`
 * outside the adapters, and refuses `vscode` inside the core -- so the name they
 * meet under has to be here, where both are allowed to look.
 *
 * Two moments, and they are two because they answer different questions:
 *
 *   * `opened` -- a terminal now exists and has bytes. The audience starts
 *     keeping them from this instant, whether or not anybody is looking: output
 *     that arrived before the first person glanced at the panel is exactly the
 *     output that says why a launch failed.
 *   * `shown` -- somebody asked for THIS terminal to be the one on screen.
 *     `preserveFocus` is carried through untouched, and the difference it
 *     stands for is П7: a window restoring six terminals at start-up must not
 *     take the person's cursor six times, while a person who pressed "new
 *     terminal" is asking for exactly that.
 *
 * There is no `closed`: a terminal's end already arrives through
 * `TerminalScreen.onExit`, which the audience is holding anyway, and a second
 * road to the same fact is a second thing to keep in step.
 */
export interface TerminalAudience {
  opened: (handle: TerminalHandle) => void;
  shown: (terminalId: TerminalId, preserveFocus: boolean) => void;
}
