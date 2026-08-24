import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';
import { describeDetails } from '../../domain/services/log-details';
import type { LogLine, LogSink } from '../../domain/ports/logger';

/**
 * How large one window's log may grow before it rolls over.
 *
 * Four megabytes, which is about forty thousand lines of this build's shape --
 * far more than any window writes in a sitting, and small enough that the two
 * files together are something a person can attach to a message. The previous
 * file is kept rather than removed, because the interesting minute is usually
 * the one before somebody noticed.
 */
export const MAX_LOG_BYTES = 4_194_304;

/** What the rolled-off file is called. One generation, and no more. */
const ROLLED_SUFFIX = '.1';

export interface FileLogOptions {
  readonly path: string;
  /** Overridden only by a test. See `MAX_LOG_BYTES`. */
  readonly maxBytes?: number;
}

/**
 * The product's log, in the store.
 *
 * **What it is for.** Until this existed, the only evidence of a window going
 * wrong was a screenshot the owner happened to take: a report command has to be
 * run IN the broken window, and a person closes the window first. With the log
 * beside the records it is about, the request is one sentence and it never
 * changes -- send me the `.gripterm` folder -- and it works backwards, on the
 * sitting that already went wrong.
 *
 * **Synchronous, and that is the decision.** An asynchronous append returns
 * before it lands, so the last lines before a window is closed -- which are the
 * lines that say what it was doing when it stopped -- are exactly the ones a
 * queue loses. What it costs is a file system call per line on the extension
 * host's thread, which this build makes a couple of hundred times per sitting.
 *
 * **It gives up rather than nagging.** The first write that fails throws, so
 * that whoever attached it learns; every write after that does nothing at all.
 * `LogRelay` is what turns the first throw into one sentence in the channel and
 * lets go. A sink that threw on every line would put a second failure inside
 * the reporting of the first one, forever.
 */
export class FileLog implements LogSink {
  private readonly _path: string;
  private readonly _maxBytes: number;
  private _bytes: number | null = null;
  private _givenUp = false;

  constructor(options: FileLogOptions) {
    this._path = options.path;
    this._maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    // Made here rather than on the first line, so that a store this build cannot
    // write to is discovered by whoever attaches the sink instead of by the
    // first failure it was supposed to be reporting.
    mkdirSync(dirname(this._path), { recursive: true, mode: STORAGE_DIRECTORY_MODE });
  }

  public write(line: LogLine): void {
    if (this._givenUp) {
      return;
    }
    const text = format(line);
    try {
      this._rollIfFull(Buffer.byteLength(text, 'utf8'));
      appendFileSync(this._path, text, 'utf8');
      this._bytes = (this._bytes ?? 0) + Buffer.byteLength(text, 'utf8');
    } catch (cause: unknown) {
      this._givenUp = true;
      throw cause;
    }
  }

  /**
   * Rolls the file over when the next line would take it past the ceiling.
   *
   * The size is remembered rather than asked for every time: `statSync` per line
   * doubles the cost of a log, and this is the only writer of this file -- one
   * per window, named after the window (`StorageLayout.logFile`). It is asked
   * once, on the first line, because the file may be the one an EARLIER window
   * with this id left -- which cannot happen with a minted uuid, and is checked
   * anyway rather than argued about.
   */
  private _rollIfFull(incoming: number): void {
    this._bytes ??= sizeOf(this._path);
    if (this._bytes + incoming <= this._maxBytes) {
      return;
    }
    // `renameSync` over an existing file replaces it on both platforms this ships
    // to, so the generation before last goes without a second call.
    renameSync(this._path, `${this._path}${ROLLED_SUFFIX}`);
    this._bytes = 0;
  }
}

/**
 * One line: the moment, the level, the sentence, and the context as JSON.
 *
 * The context goes through `describeDetails`, which is the function that knows
 * an `Error` is not `{}` and that a log line must never be the thing that
 * throws. It also escapes newlines, so a stack -- twenty lines of text -- stays
 * one line here. A log where one entry is sometimes twenty is a log neither an
 * eye nor a `grep` can read.
 */
function format(line: LogLine): string {
  const rendered = describeDetails(line.details);
  const context = rendered === '' ? '' : ` ${rendered}`;
  return `${line.at.toISOString()} ${line.level} ${line.message}${context}\n`;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    // Not there yet, which is the ordinary case: the window that owns this name
    // is the one that just started.
    return 0;
  }
}
