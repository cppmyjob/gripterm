/**
 * The values `claude --permission-mode` accepts -- exactly six, measured on
 * build 2.1.225 by reading `claude --help`.
 *
 * There is NO `default`. An earlier draft of the design documents carried one,
 * and it would have been the expensive kind of wrong: an unknown value makes
 * the CLI exit at startup, so every launch built from such a recipe would fail
 * before producing a single hook event. Absence of a mode is expressed by
 * `null` -- do not pass the flag at all.
 *
 * `bypassPermissions` is never offered in the UI. It exists here because a
 * recipe may be written by hand and must round-trip faithfully.
 */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan';

export const PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}
