import type { ConfigurationChangeEvent } from 'vscode';

/**
 * What a window says when somebody changes a setting it has already read.
 *
 * Every setting of this extension is read ONCE, at activation: the store, the
 * watcher, the journal policy, the notification list, the launch mode and place,
 * and the engine that makes terminals are all composed from those readings and
 * then held. So an edit made under a running window does nothing whatever -- and
 * "did nothing" and "took effect and did not work" are the same picture from the
 * person's chair. The change is answered by a sentence rather than by silence.
 *
 * Why not re-read instead. For the store that was measured and refused in M2
 * (`settings.ts`, `readStorageDir`): moving the base under a running window
 * would leave live CLIs pointing at the directory we just left. For the engine
 * it is stronger still -- the gateway is built once, every terminal on screen
 * was made by it, and half of the composition (the panel, the strip, the
 * bridges) exists only under one of the two. A window that swapped engines in
 * place would be a second composition beside the first.
 *
 * The list below and the manifest say the same thing twice on purpose, and a
 * test holds them together: the description a person reads in the settings
 * editor ends with the same promise this file keeps. A setting that ever starts
 * being read live leaves BOTH, or the test says which one was forgotten.
 *
 * Nothing here touches the editor at run time: the `vscode` import is a type and
 * erases, which is what lets the rule be tested by plain `jest` with no host.
 */

/** A setting read once, and what it is that was read -- in the words of the sentence. */
export interface ReadOnceSetting {
  readonly setting: string;
  readonly reads: string;
}

/** The sentence every one of them earns. The subject is filled in from `reads`. */
export function noticeFor(known: ReadOnceSetting): string {
  return `Gripterm reads ${known.reads} once, when the window loads. Reload the window for the change to take effect.`;
}

/**
 * Every setting this build has, because it reads every one of them at activation.
 *
 * Held here rather than derived from the manifest at run time: the extension
 * would then be trusting a file it also ships, and a key silently dropped from
 * the manifest would silently drop its sentence too. The reconciliation happens
 * in the test, where a disagreement is a red run rather than a quiet one.
 */
export const READ_ONCE_SETTINGS: readonly ReadOnceSetting[] = Object.freeze([
  Object.freeze({ setting: 'gripterm.storage.path', reads: 'its storage path' }),
  Object.freeze({
    setting: 'gripterm.reconcile.intervalSeconds',
    reads: 'how often it checks the machine',
  }),
  Object.freeze({
    setting: 'gripterm.notify.toastStates',
    reads: 'which states raise a notification',
  }),
  Object.freeze({ setting: 'gripterm.launch.mode', reads: 'how a terminal is started' }),
  Object.freeze({ setting: 'gripterm.launch.location', reads: 'where a terminal is opened' }),
  Object.freeze({ setting: 'gripterm.terminal.engine', reads: 'which engine makes a terminal' }),
  Object.freeze({
    setting: 'gripterm.terminal.ideChannel',
    reads: 'whether an agent of ours may connect itself to the Claude Code extension',
  }),
  Object.freeze({
    setting: 'gripterm.journal.includeContent',
    reads: 'what the event journal is allowed to keep',
  }),
  Object.freeze({
    setting: 'gripterm.journal.retentionDays',
    reads: 'how long the event journal is kept',
  }),
  Object.freeze({
    setting: 'gripterm.journal.maxSizeMb',
    reads: 'the size cap of the event journal',
  }),
]);

/**
 * What to say about a configuration change, or nothing at all.
 *
 * A list rather than a single sentence because one edit of `settings.json` can
 * move several keys, and a person who moved several is owed all of them -- the
 * event carries no order, so there is no first one to prefer.
 */
export function reloadNotices(event: ConfigurationChangeEvent): readonly string[] {
  return READ_ONCE_SETTINGS.filter((known) => event.affectsConfiguration(known.setting)).map(
    noticeFor
  );
}
