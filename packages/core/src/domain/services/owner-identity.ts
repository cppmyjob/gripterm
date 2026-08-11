import { OwnerRef } from '../entities/owner-ref';
import type { EditorKind } from '../entities/owner-ref';
import type { OwnerId } from '../entities/owner-id';
import type { OwnerIdentity } from '../ports/owner-presence';

/**
 * What each editor calls itself, matched inside a lowercased `appName`.
 *
 * A list rather than a `switch`, because the input is a marketing string and not
 * an enumeration: "Visual Studio Code - Insiders" and "Visual Studio Code" are
 * the same editor, and a fork can call itself anything at all.
 *
 * Cursor is first on purpose. A fork that named itself after both -- "Cursor
 * (Visual Studio Code)" -- is the one case where order decides, and the more
 * specific answer is the true one.
 *
 * The list is deliberately short. Everything not named here is `unknown`, and
 * that costs almost nothing: `editorKind` is a label for display and is
 * explicitly NOT part of the restore predicate (§6), because a terminal is
 * `claude` in a working directory and does not care which editor started it.
 * Guessing wrong would therefore buy a wrong label; guessing at all would buy a
 * rule keyed on a name nobody measured.
 */
const EDITORS: readonly { readonly needle: string, readonly kind: EditorKind }[] = [
  { needle: 'cursor', kind: 'cursor' },
  { needle: 'visual studio code', kind: 'vscode' },
  { needle: 'code - oss', kind: 'vscode' },
];

/**
 * Which editor this is, from the name it gives itself.
 *
 * `appHost` is NOT an input, although the plan's line for M1.13 names it. It
 * answers a different question -- where the workbench is running (desktop, web,
 * a codespace) -- and every one of those answers is compatible with every
 * editor here. Feeding it in would make the kind depend on something that does
 * not determine it.
 *
 * `none` is never returned. It belongs to an owner with no editor at all -- the
 * background orchestrator `OwnerKind: 'service'` is reserved for -- and there is
 * nothing to detect in that case, because such an owner never asks.
 */
export function identifyEditor(appName: string): EditorKind {
  const name = appName.toLowerCase();
  return EDITORS.find(({ needle }) => name.includes(needle))?.kind ?? 'unknown';
}

/** The facts a host knows about itself. Every one of them is read, never guessed. */
export interface WindowFacts {
  readonly ownerId: OwnerId;
  /** `vscode.env.appName`. */
  readonly appName: string;
  /** `vscode.version`. */
  readonly editorVersion: string;
  /** The extension host's own process id -- what M2.12 asks the system about. */
  readonly pid: number;
  readonly workspaceFolders: readonly string[];
}

/**
 * This window, as other windows will read it out of `owners/<ownerId>.json`.
 *
 * `kind` is fixed at `'window'` here, and that is the whole of what M1 needs: a
 * `'service'` owner is an orchestrator with no editor, which nothing in the MVP
 * produces. Fixing it in one place is what makes adding the other kind a change
 * to one function rather than a search.
 *
 * The folders are copied. `readonly string[]` is a promise to the compiler only:
 * the caller keeps its array and could push to it afterwards, which would edit
 * an identity that has already been announced.
 */
export function identifyWindow(facts: WindowFacts): OwnerIdentity {
  return Object.freeze({
    ownerId: facts.ownerId,
    kind: 'window',
    pid: facts.pid,
    editorKind: identifyEditor(facts.appName),
    editorVersion: facts.editorVersion,
    workspaceFolders: Object.freeze([...facts.workspaceFolders]),
  });
}

/**
 * The identity as it is stamped INTO a terminal's record.
 *
 * The two owner types answer different questions -- "who is out there" against
 * "whose is this" -- and this is the single place they are derived from one
 * another, so that they cannot come to disagree about the same window.
 *
 * One folder, because that is what `OwnerRef` holds, and the first because a
 * window's terminals are created in it (M1.12). `null` for a window with no
 * folder open belongs to windows with no folder open, which is what makes such
 * a record restorable at all (§6).
 */
export function ownerRefFor(identity: OwnerIdentity): OwnerRef {
  return OwnerRef.create({
    kind: identity.kind,
    ownerId: identity.ownerId,
    editorKind: identity.editorKind,
    workspaceFolder: identity.workspaceFolders[0] ?? null,
  });
}
