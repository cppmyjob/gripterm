import { isAbsolute, join } from 'node:path';

/** The name of the base directory under the person's home. Written once, here. */
export const DEFAULT_STORAGE_DIRECTORY = '.gripterm';

const HOME_PREFIXES = ['~/', '~\\'] as const;

export interface StorageDirChoice {
  readonly path: string;
  /**
   * Why the configured value was not used, or `null` when it was -- and also
   * `null` when there was nothing configured at all, which is not a refusal.
   */
  readonly refused: string | null;
  /**
   * Whether the path below came from the person's settings or from the default.
   *
   * `refused !== null` always means `false` here: a value we would not use is
   * not a value that put us anywhere. It is a separate field because `refused:
   * null` says two different things -- "you asked for this and got it" and "you
   * asked for nothing" -- and a caller that MUST NOT guess where the store is
   * has to tell them apart. That caller exists: a test host and a development
   * host both run on top of somebody's real profile, and the default path is
   * exactly the one directory they must never be handed by accident.
   */
  readonly configured: boolean;
}

/**
 * Where the store lives, from what the person configured.
 *
 * The rule that matters is the one about a RELATIVE path. Resolving one would
 * not fail: it would quietly make a `.gripterm` next to whatever directory the
 * extension host happened to start in, and the person would find an empty list
 * and a full disk somewhere else. So a relative path is refused and said out
 * loud, and the default is used instead -- the store is not something to guess
 * the location of.
 *
 * `~` is expanded because a person typing a path into `settings.json` writes it
 * the way they write it in a shell, and a literal `~` directory appearing in
 * their home is a bug report nobody enjoys writing.
 */
export function chooseStorageDir(params: {
  readonly configured: unknown;
  readonly home: string;
}): StorageDirChoice {
  const fallback = join(params.home, DEFAULT_STORAGE_DIRECTORY);
  const { configured } = params;

  if (configured === undefined || configured === null || configured === '') {
    // Not configured. The empty string is the manifest's own default, and a
    // person clearing the box means "go back to the default" rather than "put
    // it at the root of the drive".
    return { path: fallback, refused: null, configured: false };
  }
  if (typeof configured !== 'string') {
    return {
      path: fallback,
      refused: 'the configured storage path is not a string',
      configured: false,
    };
  }

  const expanded = expandHome(configured.trim(), params.home);
  if (!isAbsolute(expanded)) {
    return {
      path: fallback,
      refused: 'the configured storage path is not absolute',
      configured: false,
    };
  }
  return { path: expanded, refused: null, configured: true };
}

function expandHome(configured: string, home: string): string {
  for (const prefix of HOME_PREFIXES) {
    if (configured.startsWith(prefix)) {
      return join(home, configured.slice(prefix.length));
    }
  }
  return configured;
}

/**
 * The setting a person points the store at, spelled once and here.
 *
 * The refusal below has to name the way out of itself, and the way out is this
 * key. Spelling it into that sentence by hand would make the remedy a thing
 * somebody remembers rather than a thing a run can check; a test reconciles this
 * constant with the manifest instead.
 */
export const STORAGE_PATH_SETTING = 'gripterm.storage.path';

/**
 * Why this window must not open the store it was about to open -- or `null`,
 * which is the ordinary answer.
 *
 * The store is chosen from a HOME directory, and a window connected to a remote
 * has a different home from the local window open on the same folder. One
 * project opened both ways is therefore two stores, and neither can read the
 * other's `owners/`. Nothing fails and nothing is logged: both sides simply find
 * every conversation unowned, which is the exact state every guard in this build
 * treats as permission to start. The first symptom is two agents resuming one
 * transcript, and that is the one act here that no undo of ours reaches.
 *
 * So the answer is to refuse to run, and it is deliberately the ugly one (II.4).
 * A window that will not open costs a person their morning and can be taken back
 * in one setting; a second `claude --resume` on live work cannot be taken back at
 * all. The alternative -- carry on and let ownership quietly mean nothing -- is
 * not a smaller cost, it is an unmeasured one.
 *
 * A CONFIGURED path is not refused, and that is the entire width of the exit. A
 * person who set the path has taken the question on themselves and is the only
 * party who can answer it: `C:\Users\x\.gripterm` from Windows and
 * `/mnt/c/Users/x/.gripterm` from WSL are one real directory, and this build can
 * neither know that nor sensibly guess it. The flag it reads is the one that
 * already exists -- `StorageDirChoice.configured` separates "you asked for this"
 * from "you asked for nothing" -- rather than a second notion of deliberateness
 * standing beside it and drifting from it.
 *
 * What this does NOT catch, said here rather than discovered later. Two LOCAL
 * hosts pointed at two different configured paths are two stores as well, and
 * this returns `null` for them: that is somebody asking for two stores, not
 * being handed them. And a store that came from neither the home directory nor
 * the setting -- the one a development host is given -- is a split that was
 * already announced to the person who caused it, so the caller decides whether
 * to ask at all rather than this deciding for them.
 */
export function refuseSplitStore(params: {
  readonly remoteName: string | undefined;
  readonly choice: StorageDirChoice;
}): string | null {
  const { remoteName, choice } = params;
  if (remoteName === undefined) {
    // Not a remote extension host: one home, one store, nothing to be two of.
    return null;
  }
  if (choice.configured) {
    // The deliberate act. Somebody named this directory, and naming it on both
    // sides is the one way the two hosts can be made to mean one store.
    return null;
  }
  return (
    `Gripterm will not open a store only one side of this project can see: this window runs on a ` +
    `remote extension host (${remoteName}), so the store would be ${choice.path} -- under the home ` +
    `directory of THAT host, which the local window on the same folder does not share. Both sides ` +
    `would then hold the same conversations while neither could see the other's owner files, and ` +
    `nothing would stand between them and a second claude --resume on a transcript that is already ` +
    `running. Set ${STORAGE_PATH_SETTING} on both sides to one real directory -- from Windows and ` +
    `from WSL the same folder has two names -- and this window will open it.`
  );
}
