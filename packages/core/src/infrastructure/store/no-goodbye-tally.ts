import { asFiniteNumber, asRecord, asString, asStringArray } from '../../domain/json/json-readers';
import { readJsonFile, writeJsonFile } from './json-file';
import type { LeftoverRun } from '../../domain/services/runs-without-a-goodbye';
import type { Logger } from '../../domain/ports/logger';
import type { StorageLayout } from './storage-layout';

/** `runs-without-a-goodbye.json`, as it is on disk. */
export interface NoGoodbyeDocument {
  readonly starts: number;
  readonly runs: number;
  readonly lastAt: string;
  readonly counted: readonly string[];
}

/**
 * The two numbers, which are two different facts and not one rounded twice.
 *
 * `starts` answers the owner's question as it was asked -- how many times did we
 * come up after a run that had not said goodbye. `runs` answers the one behind
 * it: how many such runs there have been. They part company when one start finds
 * two leftover files, which is what two windows ending together looks like.
 */
export interface NoGoodbyeTotals {
  readonly starts: number;
  readonly runs: number;
}

export interface NoGoodbyeCount {
  /** The runs THIS start added, which are the ones no earlier start had counted. */
  readonly counted: readonly LeftoverRun[];
  readonly totals: NoGoodbyeTotals;
}

export interface NoGoodbyeTallyOptions {
  readonly layout: StorageLayout;
  readonly logger: Logger;
}

/**
 * How many times this store has been opened after a run that left no goodbye
 * (Ш33).
 *
 * **What the number is for.** О1 was first walked under our own engine on
 * 2026-08-31 and went red, because under that engine the terminal's pty lives
 * inside our extension host: kill the host and the agent goes with it. The
 * acceptance gets there by KILLING the host, which is a blow and not an
 * observation -- how often a run ends that way on somebody's own machine is
 * known by nobody. The answer decides whether a pty host of its own is worth
 * several days, so it is measured rather than guessed.
 *
 * **What the number is NOT.** It is not a count of anything falling over. A
 * person who ends the editor from the task manager leaves exactly the file this
 * counts, and so does every other hard end; this build cannot tell them apart
 * and does not pretend to. What is established is what the name says and no
 * more: a run left no goodbye, and the machine did not restart in between.
 *
 * **Each run once.** A presence file left by a window that is gone stays in
 * `owners/` until the reconciler collects it, and it will not while any record
 * still names that window. Without `counted` the totals would grow with the
 * number of windows a person opens rather than with what happened, so the names
 * already counted are kept -- and pruned to what the directory still holds, so
 * the memory is bounded by `owners/` and not by history.
 */
export class NoGoodbyeTally {
  constructor(private readonly _options: NoGoodbyeTallyOptions) {}

  /**
   * Adds the runs this start found that no earlier start had, and answers the
   * totals as they now stand.
   *
   * `null` for a start that found nothing new, and nothing is written for one:
   * the common start of an ordinary day touches this file not at all, which is
   * the whole of what keeps it off the start's budget.
   *
   * @param candidates every run this start found that left no goodbye
   * @param surveyed the names `owners/` holds right now, which is what the memory is pruned to
   */
  public async count(
    candidates: readonly LeftoverRun[],
    surveyed: ReadonlySet<string>,
    at: Date
  ): Promise<NoGoodbyeCount | null> {
    if (candidates.length === 0) {
      return null;
    }
    const known = await this._read();
    const counted = candidates.filter((run) => !known.counted.includes(run.ownerId));
    if (counted.length === 0) {
      return null;
    }

    const totals: NoGoodbyeTotals = {
      starts: known.starts + 1,
      runs: known.runs + counted.length,
    };
    await this._write({
      ...totals,
      lastAt: at.toISOString(),
      // Pruned here and only here, so the file is rewritten only on a start that
      // had something to add. A name is dropped when its file has gone from
      // `owners/`; the total it was already added to does not move with it.
      counted: [
        ...known.counted.filter((name) => surveyed.has(name)),
        ...counted.map((run) => run.ownerId),
      ],
    });
    return { counted, totals };
  }

  /**
   * What the file says, or a fresh start over one nothing can be read from.
   *
   * **The direction of that failure, named rather than defended against.** A
   * damaged file makes the totals under-report everything before the damage, and
   * lets a run already counted be counted again. Both are visible: the log line
   * beside this one names the run and its moment every time, so the record of
   * WHAT happened survives a total that lost its place.
   */
  private async _read(): Promise<NoGoodbyeDocument> {
    const file = this._options.layout.noGoodbyeFile;
    const read = await readJsonFile(file);
    if (read.kind === 'absent') {
      return EMPTY;
    }
    const document = read.kind === 'value' ? decode(read.value) : null;
    if (document !== null) {
      return document;
    }
    this._options.logger.warn(
      'the count of runs that did not say goodbye could not be read, so this start begins the count again',
      {
        file,
        reason: read.kind === 'unreadable' ? read.reason : 'it does not hold the four fields of a count',
      }
    );
    return EMPTY;
  }

  private async _write(document: NoGoodbyeDocument): Promise<void> {
    const file = this._options.layout.noGoodbyeFile;
    try {
      await writeJsonFile(file, document);
    } catch (cause: unknown) {
      // A warning and not a failure: the start goes on, and the line that says
      // what this one found is written either way. What is lost is the running
      // total, which the next start begins from where this one left it.
      this._options.logger.warn(
        'the count of runs that did not say goodbye could not be written, so this start is missing from it',
        { file, cause }
      );
    }
  }
}

const EMPTY: NoGoodbyeDocument = { starts: 0, runs: 0, lastAt: '', counted: [] };

/** All four fields or nothing: a half-read count is a number somebody would quote. */
function decode(value: unknown): NoGoodbyeDocument | null {
  const raw = asRecord(value);
  const starts = asFiniteNumber(raw?.starts);
  const runs = asFiniteNumber(raw?.runs);
  const lastAt = asString(raw?.lastAt);
  const counted = asStringArray(raw?.counted);
  return starts === null || runs === null || lastAt === null || counted === null
    ? null
    : { starts, runs, lastAt, counted };
}
