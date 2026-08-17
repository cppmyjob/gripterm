import type { Disposable } from './disposable';

/**
 * What the platform said when the process behind a screen ended: a number, a
 * signal, or neither.
 *
 * The platform's raw word, deliberately -- it is NOT the pair a record is
 * written from. Turning it into that pair needs one thing this object cannot
 * carry, which is why the terminal went away, and only the code that ended it
 * knows that. `exitVerdict` is where the two meet.
 *
 * Both fields are `number | undefined` rather than `number`, and that is about
 * where they come from: node-pty always supplies a code today, but an adapter is
 * the place where a platform turns out to differ, and a shape that could not
 * represent "it did not say" would force an adapter to invent a number.
 */
export interface ScreenExit {
  readonly code: number | undefined;
  readonly signal: number | undefined;
}

/**
 * A terminal's bytes, in both directions -- the half of a terminal that the
 * editor's own API does not have.
 *
 * A SECOND port rather than more methods on `TerminalGateway`, and the reason is
 * a fact about the platform rather than a preference: **there is no
 * `onDidWriteTerminalData` in the stable API** -- no occurrence of it anywhere in
 * `@types/vscode` 1.94 (§4.1). A gateway that promised bytes would force
 * `VsCodeTerminalGateway` to throw "not supported" from a method its own port
 * declares, which is the kind of rule no test catches.
 *
 * So this arrives as an OPTIONAL field beside a handle: the `own` engine has one
 * per terminal, the `editor` engine has none, and that difference is a line of
 * the contract rather than something a caller is left to discover. Every reader
 * of `TerminalHandle.screen` therefore starts by having no screen at all.
 *
 * **Two promises that are measurements rather than manners** (M3.2 stage B,
 * 2026-08-17):
 *
 *   * `write` and `resize` AFTER the process has ended are ignored, not thrown
 *     out of. node-pty throws `Cannot resize a pty that has already exited`, and
 *     it was measured doing so four times out of five while a resize was in
 *     flight against a stream that was finishing (§8). A caller cannot avoid it
 *     by asking first: there is no instant between the question and the call in
 *     which the answer is guaranteed to still hold.
 *   * `onExit` reports at most once. The end of a pty reaches an adapter from
 *     more than one direction -- the event, and the kill that provoked it -- and
 *     a record written twice is two deaths for one dying.
 *
 * **What it is not.** Not a recording: nothing here retains what went past
 * (§7.2). A consumer that needs the tail of the output in order to draw a screen
 * again keeps it itself, in a `ScreenBuffer` with a named ceiling.
 */
export interface TerminalScreen {
  /** Bytes towards the process, exactly as given. Nothing is appended, `\r` included. */
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (listener: (chunk: string) => void) => Disposable;
  onExit: (listener: (exit: ScreenExit) => void) => Disposable;
  /**
   * Lets the screen go.
   *
   * For the `own` engine this is the same act as disposing the handle -- there
   * is one pty behind both -- and the port keeps its own because the screen is
   * optional beside the handle, so a consumer may hold nothing else.
   * Idempotent: a second call is not an error.
   */
  dispose: () => void;
}
