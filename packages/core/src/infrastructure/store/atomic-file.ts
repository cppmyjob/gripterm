import { rename, rm, writeFile } from 'node:fs/promises';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';

/**
 * How long to wait before each retry, in milliseconds.
 *
 * Three attempts after the first, growing, and finishing inside a tenth of a
 * second. The hazard being waited out is measured and short: `rename` over a
 * target that a CONCURRENT READER holds open fails with `EPERM` on Windows
 * (§2.1a), and that reader is another window's `readFile`, which lasts
 * microseconds. A longer ladder would not catch a different failure -- it would
 * only make a genuinely locked file take longer to report.
 */
const FIRST_PAUSE_MS = 5;
const PAUSE_GROWTH = 3;
const RETRIES = 3;

const BACKOFF_MS: readonly number[] = Array.from(
  { length: RETRIES },
  (_unused, attempt) => FIRST_PAUSE_MS * PAUSE_GROWTH ** attempt
);

/*
 * There is no list of retryable codes, and the plan named two (`EPERM`,
 * `EBUSY`). Every failure of the rename is retried instead, for a reason that
 * is about testability rather than taste: a code the list excluded would be a
 * branch no test on this platform could reach, and an unreachable branch is a
 * rule nobody can prove still holds. The two named codes are retried either
 * way, and retrying a hopeless one -- `ENOSPC`, say -- costs the sixty
 * milliseconds of the ladder and then reports the file system's own error
 * unchanged.
 */

/**
 * Makes every scratch name unique WITHIN this process as well as between
 * processes.
 *
 * The pid alone is not enough, and that was found by a test rather than by
 * reasoning: three writers in one process shared `<path>.<pid>.tmp`, and the
 * first rename carried off a file the others were still using. Two windows are
 * two processes, so the pid covers them -- but one window debouncing two writes
 * of the same record is one process, and the single-writer rule says nothing
 * about a writer racing itself.
 */
let scratchCounter = 0;

export interface AtomicWriteOptions {
  /** For tests. Real callers take the ladder above. */
  readonly backoffMs?: readonly number[];
}

/**
 * Replaces a file so that no reader ever sees it half-written.
 *
 * Content lands in a neighbour and arrives by `rename`, which is atomic on both
 * platforms we target: a reader either has the old file or the new one, never
 * the middle. The neighbour's name is unique per call -- see `scratchCounter`
 * -- so two writers cannot collide on it. They should not both be here, one
 * live owner per record (§4.8), but a name is cheap insurance against a rule
 * that holds by design rather than by mechanism.
 *
 * Own code rather than `write-file-atomic` (decision №35), and the reason is
 * specific: that package has neither a catch nor a retry around `rename`
 * itself. It solves temp-name collisions, which is not the failure this
 * platform actually produces.
 *
 * The caller creates the directory. This function is about one file, and a
 * `mkdir` hidden inside it would make an unwritable path look like a write
 * failure of the file rather than of its home.
 */
export async function writeAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  scratchCounter += 1;
  const scratch = `${path}.${process.pid}.${scratchCounter}.tmp`;
  const backoff = options.backoffMs ?? BACKOFF_MS;

  try {
    await writeFile(scratch, content, { encoding: 'utf8', mode: STORAGE_DIRECTORY_MODE });
    await renameWithRetry(scratch, path, backoff);
  } catch (cause: unknown) {
    await discard(scratch);
    throw cause;
  }
}

/**
 * Moves a file or a whole directory, waiting out the same `EPERM` the ladder in
 * `writeAtomic` waits out -- reached, here, by a different route.
 *
 * Which route was measured on 2026-08-24 rather than reasoned, one question at
 * a time, because the answer is not the symmetrical one it reads like. A
 * `rename` whose SOURCE FILE a concurrent reader holds open SUCCEEDS on
 * Windows. What is refused with `EPERM` (§2.1a) is a rename onto a target held
 * open -- `writeAtomic`'s case -- and a rename of a DIRECTORY holding a file
 * somebody has open. Only the second of those can reach this function, and only
 * through one caller: `StorageCleaner.sweep`, moving `terminals/<id>` into the
 * trash while another window reads the records inside it. The callers that move
 * one file cannot meet it at all, and for them the ladder is insurance.
 *
 * There is no scratch file here and there does not need to be one. Nothing is
 * being replaced -- the destination is a directory a caller has just created --
 * so the move is either done or not done, and a reader of the source sees the
 * old file until it is gone.
 */
export async function moveAtomic(
  from: string,
  to: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await renameWithRetry(from, to, options.backoffMs ?? BACKOFF_MS);
}

async function renameWithRetry(
  from: string,
  to: string,
  backoff: readonly number[]
): Promise<void> {
  for (const pause of backoff) {
    try {
      await rename(from, to);
      return;
    } catch {
      await sleep(pause);
    }
  }
  // The last attempt is outside the loop on purpose: its failure is the one the
  // caller sees, and it must arrive as the file system's own error rather than
  // as a summary of ours. A person reading `EPERM` can look it up; a person
  // reading "gave up after 3 tries" cannot.
  await rename(from, to);
}

async function discard(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Deliberately swallowed. The write failure on its way out is the one worth
    // reporting; replacing it with the failure of its own cleanup would hand
    // the caller the symptom of the symptom.
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
