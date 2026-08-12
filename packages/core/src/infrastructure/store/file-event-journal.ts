import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { STORAGE_DIRECTORY_MODE, journalDay } from './storage-layout';
import { StorageError } from '../../domain/errors/gripterm-error';
import { encodeJournalLine } from './journal-line';
import { journalDayFiles, lastSequenceIn } from './journal-reader';
import type { EventJournal } from '../../domain/ports/event-journal';
import type { HookDelivery } from '../../domain/entities/hook-delivery';
import type { Logger } from '../../domain/ports/logger';
import type { StorageLayout } from './storage-layout';
import type { TerminalId } from '../../domain/entities/terminal-id';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const MS_PER_DAY = 86_400_000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_SIZE_MB = 64;

/**
 * What the person configured, as the journal sees it (§4.8's `gripterm.journal.*`).
 *
 * Held by value and read once, as every setting in this build is: a change takes
 * effect when the window reloads. Said here because one of these is a privacy
 * setting, and "turned it off and it kept writing" is the kind of surprise that
 * has to be written down rather than discovered.
 */
export interface JournalPolicy {
  /** Whether prompts, answers and tool arguments reach the file at all. */
  readonly includeContent: boolean;
  /** Days of history kept beside the day being written. */
  readonly retentionDays: number;
  readonly maxSizeBytes: number;
}

export const DEFAULT_JOURNAL_POLICY: JournalPolicy = {
  includeContent: false,
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxSizeBytes: DEFAULT_MAX_SIZE_MB * BYTES_PER_MB,
};

export interface FileEventJournalOptions {
  readonly layout: StorageLayout;
  readonly logger: Logger;
  readonly policy: JournalPolicy;
}

/** The file this journal is currently appending to, and where its numbering stands. */
interface OpenDay {
  readonly day: string;
  readonly path: string;
  nextSeq: number;
}

/**
 * The journal: one directory per terminal, one file per day, one line per
 * delivery.
 *
 * NDJSON and not a JSON array, because the two differ exactly where it matters:
 * an array has to be re-read and rewritten to grow, so a crash mid-write costs
 * the whole history, while a line either arrived or did not. It is also the one
 * format a person can read with `tail`.
 *
 * Three things are new since M1 and each is a rule rather than a feature:
 *
 *   * **`seq`.** An append-only file cannot tell a reader what it never
 *     received. The counter can, and it is recovered from the FILE when a day is
 *     first touched -- never carried in memory across a restart, because after a
 *     restart, an adoption, or a machine that came back to a day it had already
 *     written, a remembered counter would be confidently wrong.
 *   * **A day per file.** Retention that cannot delete anything is not
 *     retention, and an append-only file cannot be trimmed from the front.
 *   * **A content filter that is an allowlist** (`journal-line.ts`). With
 *     `includeContent` off -- the default -- a field this build has not been
 *     taught about is dropped and its name recorded.
 */
export class FileEventJournal implements EventJournal {
  /**
   * Appends are serialised through this chain rather than issued concurrently.
   *
   * `appendFile` opens with `O_APPEND`, which orders whole writes on POSIX but
   * makes no such promise for a large buffer on Windows, and this project is
   * developed on Windows. A torn line is not a lost event that anyone notices:
   * it is an unparseable record in the middle of a history, discovered whenever
   * someone finally reads it.
   *
   * NOT DEMONSTRATED BY THE SUITE, and said so here rather than left to be
   * discovered: a mutation removing this queue survives every test, at 40
   * concurrent appends and at 128 KB per line (2026-08-11). Windows landed each
   * write whole regardless. It is kept because that is a platform's behaviour
   * on one machine and not a guarantee anybody makes -- the same judgement, and
   * the same honesty about it, as the staged `rename` in M1.6 (§8.2).
   *
   * Since M2.4a it also serialises the day-opening: rotation reads a file and
   * prunes a directory, and two appends doing that at once would number the
   * same line twice.
   */
  private _tail: Promise<void> = Promise.resolve();

  private readonly _open = new Map<string, OpenDay>();

  constructor(private readonly _options: FileEventJournalOptions) {}

  public async append(delivery: HookDelivery): Promise<void> {
    const next = this._tail.then(async () => { await this._write(delivery); });
    // The tail swallows the failure; the CALLER still gets it through `next`.
    // Without this the chain would carry one refusal from the file system into
    // every later append, and the journal would stop working from then on --
    // silently, which is the exact defect this class exists to prevent.
    // Assigned BEFORE the await, so two calls made in the same tick still queue
    // behind one another rather than racing for the same file.
    this._tail = next.catch(() => undefined);
    await next;
  }

  private async _write(delivery: HookDelivery): Promise<void> {
    const open = await this._dayFor(delivery);
    const line = encodeJournalLine({
      seq: open.nextSeq,
      delivery,
      includeContent: this._options.policy.includeContent,
    });

    try {
      // The directory is created on every append rather than once per day: it
      // costs one syscall and it means a journal whose directory was removed
      // underneath it starts working again by itself.
      await mkdir(this._options.layout.eventsDir(delivery.terminalId), {
        recursive: true,
        mode: STORAGE_DIRECTORY_MODE,
      });
      // `JSON.stringify` escapes every newline inside the body, so one delivery
      // is one line however many line breaks the payload contains.
      await appendFile(open.path, `${line}\n`, 'utf8');
    } catch (cause: unknown) {
      throw new StorageError('could not append to the event journal', {
        cause,
        details: { path: open.path },
      });
    }

    // Only after the write landed. Counting a line that was never written would
    // manufacture exactly the hole `seq` exists to report.
    open.nextSeq += 1;
  }

  private async _dayFor(delivery: HookDelivery): Promise<OpenDay> {
    const key = delivery.terminalId.value;
    const day = journalDay(delivery.receivedAt);
    const open = this._open.get(key);
    if (open?.day === day) {
      return open;
    }

    const path = this._options.layout.journalFile(delivery.terminalId, delivery.receivedAt);
    const opened: OpenDay = { day, path, nextSeq: (await lastSequenceIn(path)) + 1 };
    this._open.set(key, opened);
    await this._prune(delivery.terminalId, delivery.receivedAt, path);
    return opened;
  }

  /**
   * Enforces both limits of §4.8, once per terminal per day.
   *
   * Deleting history is the one irreversible thing this class does, so it is
   * done only to whole files, never to the file being written, and every removal
   * is logged with its path and the rule that removed it. What is left after
   * both rules is what the person asked to keep.
   *
   * A failure here is a warning and not a refusal: retention that cannot run is
   * a disk that fills up slowly, while an append that fails is an event lost
   * now, and the second is the one this class exists to prevent.
   */
  private async _prune(terminalId: TerminalId, at: Date, currentPath: string): Promise<void> {
    const { layout, logger, policy } = this._options;
    try {
      const files = (await journalDayFiles(layout, terminalId)).filter(
        (path) => path !== currentPath
      );
      // Millisecond arithmetic against a local day: around a daylight-saving
      // change this can be a day out, which is a tolerance retention has and a
      // date library would cost more than it saves here.
      const cutoff = journalDay(new Date(at.getTime() - policy.retentionDays * MS_PER_DAY));

      const kept: { readonly path: string, readonly size: number }[] = [];
      for (const path of files) {
        if (basename(path).slice(0, cutoff.length) < cutoff) {
          await this._discard(path, `it is more than ${policy.retentionDays} days old`);
          continue;
        }
        kept.push({ path, size: await sizeOf(path) });
      }

      let total = (await sizeOf(currentPath)) + kept.reduce((sum, file) => sum + file.size, 0);
      // Oldest first, which is the order the names sort in.
      for (const file of kept) {
        if (total <= policy.maxSizeBytes) {
          break;
        }
        await this._discard(file.path, 'the journal for this terminal is over its size cap');
        total -= file.size;
      }

      if (total > policy.maxSizeBytes) {
        // Nothing left to delete but the file being written, and truncating that
        // would lose today's events to save yesterday's disk. Said out loud
        // instead: a cap this build cannot honour is a cap the person has to
        // know about.
        logger.warn('the journal for this terminal is over its size cap and cannot be trimmed further', {
          path: currentPath,
          bytes: total,
          cap: policy.maxSizeBytes,
        });
      }
    } catch (cause: unknown) {
      logger.warn('the event journal could not be pruned, so it may grow past its limits', {
        terminalId: terminalId.value,
        reason: String(cause),
      });
    }
  }

  private async _discard(path: string, reason: string): Promise<void> {
    await rm(path);
    this._options.logger.info('a journal file was removed', { path, reason });
  }
}

/** `0` for a file that is not there yet, which is what a day being opened looks like. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
