/**
 * Where the editor puts a terminal we start.
 *
 * `group` is the default (M2.24), and it is a decision about what a Claude Code
 * terminal IS rather than a preference about layout: a session that runs for an
 * hour and is switched to by name is a working surface of its own, so it gets a
 * place of its own -- a group of the editor area below the editors, locked, in
 * which nothing but our terminals opens. The owner asked for "a separate panel
 * at the bottom, the way ordinary terminals do"; an extension cannot have a
 * panel, because the platform offers exactly one and it belongs to the editor,
 * so this is that picture made of the parts the platform does hand out.
 *
 * `editor` is what `group` grew out of and is kept as the way back: a tab among
 * the person's own editors, wherever the editor decides to put it.
 *
 * `panel` is kept because the choice costs one line and the argument for it is
 * real: on a small screen the editor area is the scarce thing, and somebody who
 * wants their agent under the code should have it there.
 *
 * The list lives in the neutral domain although nothing in the domain reads it,
 * for the same reason `ATTENTION_SIGNALS` does: the manifest's enum, the
 * settings reader and the adapter must not be able to drift apart, and one of
 * them is a JSON file that no compiler checks.
 */
export const LAUNCH_LOCATIONS = ['group', 'editor', 'panel'] as const;

export type LaunchLocation = (typeof LAUNCH_LOCATIONS)[number];

export function isLaunchLocation(value: string): value is LaunchLocation {
  return (LAUNCH_LOCATIONS as readonly string[]).includes(value);
}
