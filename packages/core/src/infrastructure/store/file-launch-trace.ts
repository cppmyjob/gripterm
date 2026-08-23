import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';
import type { Clock } from '../../domain/ports/clock';
import type { LaunchNote, LaunchTrace } from '../../domain/ports/launch-trace';
import type { Logger } from '../../domain/ports/logger';
import type { StorageLayout } from './storage-layout';
import type { TerminalId } from '../../domain/entities/terminal-id';

/** The version of the LINE. It moves when a reader of an old file would misread a new one. */
const LINE_VERSION = 1;

const TRACE_FILE = 'starts.jsonl';

export interface FileLaunchTraceOptions {
  readonly layout: StorageLayout;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * `terminals/<id>/starts.jsonl`: what this machine did to start that terminal.
 *
 * NDJSON beside the record, for the same reason the journal is NDJSON: a line
 * either arrived or it did not, and `tail` reads it without a tool.
 *
 * **Nothing here may fail a launch.** Every write is fire-and-forget and every
 * failure is a line in the log rather than an exception: a person whose disk is
 * full has a worse problem than a missing trace, and a terminal that would not
 * open because a diagnostic file could not be written would be this file doing
 * harm in the exact situation it exists to explain.
 *
 * **Ordered, and that is the point.** The three notes of one start -- what was
 * launched, then the pid or its absence -- are only evidence in order, so the
 * appends are chained rather than issued concurrently. `O_APPEND` orders whole
 * writes; it does not order the promises that call it.
 *
 * **No rotation.** One start is three lines of about two hundred bytes, and a
 * record is started a handful of times in its life. If that ever stops being
 * true the file is still readable from the end, which is where the answer is.
 */
export class FileLaunchTrace implements LaunchTrace {
  private readonly _options: FileLaunchTraceOptions;
  private _writing: Promise<void> = Promise.resolve();

  constructor(options: FileLaunchTraceOptions) {
    this._options = options;
  }

  public note(terminalId: TerminalId, note: LaunchNote): void {
    const line = `${JSON.stringify({
      v: LINE_VERSION,
      at: this._options.clock.now().toISOString(),
      ...note,
    })}\n`;
    this._writing = this._writing.then(async () => {
      await this._append(terminalId, line);
    });
  }

  private async _append(terminalId: TerminalId, line: string): Promise<void> {
    const directory = this._options.layout.terminalDir(terminalId);
    try {
      // The record's own directory usually exists by now, and on the first
      // launch of a brand-new record it may not: the trace is written before
      // anything else has had a reason to make it.
      await mkdir(directory, { recursive: true, mode: STORAGE_DIRECTORY_MODE });
      await appendFile(join(directory, TRACE_FILE), line, 'utf8');
    } catch (cause: unknown) {
      this._options.logger.warn('what a terminal was started with could not be written down', {
        terminalId: terminalId.value,
        cause: String(cause),
      });
    }
  }
}
