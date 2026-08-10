/**
 * Our own spelling of the editor's `Disposable`, so that a subscription can be
 * handed back from a port without `packages/core` importing `vscode`.
 *
 * Structurally satisfied by `vscode.Disposable`, which is the point: an adapter
 * returns the platform's object unchanged and no wrapper is needed.
 */
export interface Disposable {
  dispose: () => void;
}
