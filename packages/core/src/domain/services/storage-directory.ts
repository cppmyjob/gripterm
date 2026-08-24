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
