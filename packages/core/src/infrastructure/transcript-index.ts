import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Dirent } from 'node:fs';
import type { TranscriptIndex } from '../domain/entities/transcript-index';

/**
 * A transcript is `<sessionId>.jsonl`, and the id is a UUID. Measured on the
 * target machine: all 75 files sitting directly in a project directory matched
 * this, and nothing else did.
 */
const TRANSCRIPT_SUFFIX = '.jsonl';
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** No such directory. Normal, not a fault -- see the ENOENT note below. */
const ABSENT = 'ENOENT';

/**
 * Lists a directory. A seam for the same reason `SignalProbe` is one: the case
 * this file has to get right -- a directory that exists and refuses to be read,
 * which on Windows is a synchronising cloud folder or an antivirus holding a
 * handle -- cannot be produced by a test that only creates temporary files.
 */
export type DirectoryReader = (path: string) => Promise<readonly Dirent[]>;

const readDirectory: DirectoryReader = async (path) => await readdir(path, { withFileTypes: true });

/**
 * Which conversations have a transcript, by looking rather than by asking.
 *
 * WHY BY FILENAME AND NOT BY PATH. The CLI keeps transcripts under
 * `projects/<the working directory, punctuation replaced by dashes>/`, and that
 * encoding is the CLI's own, undocumented, and full of cases we have not
 * measured. Reproducing it would be a second implementation of somebody else's
 * rule -- the thing that drifts and then lies. A file NAMED for the session id
 * needs no encoding at all, and the measured layout makes the scan exact
 * (A25, 2026-08-12): one level down are the conversations, and everything
 * deeper -- `<sessionId>/subagents/...`, `agent-*.jsonl`, `journal.jsonl` -- is
 * a subagent's transcript, which is not a conversation anybody resumes. Twelve
 * project directories and 75 transcripts scanned in 1.6 ms.
 *
 * WHAT IT DOES NOT ESTABLISH. That `--resume` will succeed. The file may be
 * empty, or belong to a different working directory than the one we would
 * restore in. Both are the cheap direction: the cost is one `resume_failed`,
 * which M2.13 turns into an offer to start over, whereas the mistake this
 * predicate exists to prevent -- resuming a conversation that never began -- is
 * that same failure for EVERY untouched terminal at every restart.
 */
export async function readTranscriptIndex(
  projectsDir: string,
  reader: DirectoryReader = readDirectory
): Promise<TranscriptIndex> {
  let projects: readonly Dirent[];
  try {
    projects = await reader(projectsDir);
  } catch (cause: unknown) {
    // ENOENT is not a fault: a machine where `claude` has run but nobody has
    // sent a prompt yet has no `projects/` at all (measured 2026-08-10), and
    // "no conversations" is exactly what an empty index says.
    if ((cause as { readonly code?: unknown }).code === ABSENT) {
      return { kind: 'indexed', sessionIds: new Set(), skipped: 0 };
    }
    return { kind: 'unavailable', reason: String(cause) };
  }

  const sessionIds = new Set<string>();
  let skipped = 0;
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    let files: readonly Dirent[];
    try {
      files = await reader(join(projectsDir, project.name));
    } catch {
      // One unreadable project directory does not cost the whole index: its
      // conversations simply stay invisible, and invisible means "not
      // restorable automatically", which is the safe half of the answer. The
      // count is here so that a person can see it happened.
      skipped += 1;
      continue;
    }
    for (const file of files) {
      if (file.isFile() && TRANSCRIPT_NAME.test(file.name)) {
        sessionIds.add(basename(file.name, TRANSCRIPT_SUFFIX));
      }
    }
  }
  return { kind: 'indexed', sessionIds, skipped };
}
