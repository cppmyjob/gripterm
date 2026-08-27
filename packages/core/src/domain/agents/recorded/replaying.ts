import { join } from 'node:path';
import { DEFAULT_STORAGE_DIRECTORY } from '../../services/storage-directory';

/**
 * The environment variable that asks a window to replay a recording instead of
 * asking an agent, and the file it names.
 *
 * **Why a variable and not a setting.** A setting is a promise to a person, and
 * this is not one: it is the seam a MEASUREMENT goes through, and what it will
 * become is `gripterm.agent`, chosen from a list, the day there is a second real
 * agent to choose. A variable also cannot be set by accident from inside the
 * editor, and it disappears when the window that was started with it does.
 *
 * The window says it is replaying, every time, in a warning -- see the
 * composition root. A window whose answers came from a file must not look like a
 * window that asked.
 */
export const RECORDING_VARIABLE = 'GRIPTERM_AGENT_RECORDING';

export interface ReplayRequest {
  /** The store this window opened. */
  readonly storeDir: string;
  /** `os.homedir()`. */
  readonly home: string;
}

/**
 * Why this window may NOT replay a recording, or `null` when it may.
 *
 * A window replaying one does not ask the machine anything: every answer it gets
 * is a sentence out of a file, INCLUDING "nothing is running" -- which is the
 * sentence that permits a restore. Over the store a person keeps their terminals
 * in, that is a second `claude --resume` on each of their live conversations,
 * and no undo of ours reaches it.
 *
 * The line drawn is the one that already exists: the default store is theirs,
 * anything else was pointed at deliberately (`chooseStorageDir`,
 * `readStorageDir`). Narrow on purpose -- it is the smallest rule that still
 * allows the run this seam exists for.
 */
export function refuseToReplay(request: ReplayRequest): string | null {
  const theirs = join(request.home, DEFAULT_STORAGE_DIRECTORY);
  if (!sameDirectory(request.storeDir, theirs)) {
    return null;
  }
  return (
    `Gripterm was asked to replay a recording instead of asking an agent, and the store it opened is ${theirs} ` +
    '-- the one this person keeps their terminals in. A window running on a recording is told that nothing is ' +
    'running, which is what permits a restore, so it would start a second conversation on each of theirs. ' +
    'The recording was ignored and the real agent asked.'
  );
}

/**
 * Whether two paths name one directory, as far as this rule needs to know.
 *
 * Case-insensitively and without a trailing separator, because Windows is where
 * this runs and `C:\Users\x\.gripterm` and `c:\users\x\.gripterm\` are one
 * directory there. Deliberately no `realpath`: this is a refusal, it must answer
 * without touching a disk, and every comparison it cannot make it makes in the
 * direction of allowing -- which is why the rule is not the only thing standing
 * between a recording and a person's store (`readStorageDir` is the other).
 */
function sameDirectory(left: string, right: string): boolean {
  return trimmed(left) === trimmed(right);
}

function trimmed(path: string): string {
  return path.replace(/[\\/]+$/u, '').toLowerCase();
}
