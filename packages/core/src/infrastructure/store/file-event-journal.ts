import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '../../domain/errors/gripterm-error';
import type { HookDelivery } from '../../domain/entities/hook-delivery';
import type { EventJournal } from '../../domain/ports/event-journal';

const TERMINALS_DIRECTORY = 'terminals';
const JOURNAL_FILE = 'events.ndjson';

/**
 * The schema this line was written under, stamped per LINE rather than per file.
 *
 * A journal is append-only by construction, so one file outlives several
 * shapes: the version cannot live in a header, because the header would be
 * written before the change and read after it. §8.2 promises the schema will
 * move and does not promise compatibility -- which is only survivable if a
 * reader can tell which shape it is holding without guessing from the fields
 * that happen to be present.
 */
const LINE_VERSION = 1;

/** Owner-only, as in `FileSessionSettingsStore`; a no-op on Windows and therefore not asserted. */
const DIRECTORY_MODE = 0o700;

/**
 * The journal, one file per terminal, one line per delivery.
 *
 * NDJSON and not a JSON array, because the two differ exactly where it matters:
 * an array has to be re-read and rewritten to grow, so a crash mid-write costs
 * the whole history, while a line either arrived or did not. It is also the one
 * format a person can read with `tail`.
 *
 * The body is stored as a STRING field rather than embedded as JSON. That
 * survives a payload we cannot parse -- which is the payload most worth having,
 * since it is the one whose contract changed under us.
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
   */
  private _tail: Promise<void> = Promise.resolve();

  constructor(private readonly _baseDir: string) {}

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
    const directory = join(this._baseDir, TERMINALS_DIRECTORY, delivery.terminalId.value);
    const file = join(directory, JOURNAL_FILE);
    const line = JSON.stringify({
      v: LINE_VERSION,
      at: delivery.receivedAt.toISOString(),
      terminalId: delivery.terminalId.value,
      raw: delivery.raw,
    });

    try {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      // `JSON.stringify` escapes every newline inside `raw`, so one delivery is
      // one line however many line breaks the payload contains.
      await appendFile(file, `${line}\n`, 'utf8');
    } catch (cause: unknown) {
      throw new StorageError('could not append to the event journal', {
        cause,
        details: { path: file },
      });
    }
  }
}
