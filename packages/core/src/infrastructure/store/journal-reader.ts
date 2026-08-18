import { open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJournalLine } from './journal-line';
import { isJournalFileName } from './storage-layout';
import type { JournalLine } from './journal-line';
import type { StorageLayout } from './storage-layout';
import type { TerminalId } from '../../domain/entities/terminal-id';

/**
 * A hole in the history: the numbering says a line was written and it is not
 * here.
 *
 * This is the read side of `seq`, and the reason `seq` exists at all. An
 * append-only file cannot tell you what it never received; a counter can, and a
 * projector rebuilding state from a journal with a hole in it must know that it
 * is rebuilding from an incomplete record rather than quietly producing a
 * plausible answer.
 *
 * A `found` BELOW `expected` is not a smaller kind of gap but a different event
 * -- numbering restarted -- and it is reported through the same door because the
 * consequence for a reader is the same: what it is holding is not one
 * uninterrupted sequence.
 */
export interface JournalGap {
  readonly expected: number;
  readonly found: number;
}

export interface JournalRead {
  readonly lines: readonly JournalLine[];
  readonly gaps: readonly JournalGap[];
  /** Lines that could not be decoded: a torn write, or a shape this build does not know. */
  readonly unreadableLines: number;
  /** Paths the file system refused. Named rather than counted -- somebody has to go and look. */
  readonly unreadableFiles: readonly string[];
}

/**
 * The whole history of one terminal, oldest first.
 *
 * Never throws. A journal is read to answer a question about the past, and a
 * read that fails wholesale because one file of fifteen is unreadable answers
 * nothing at all -- so every failure is reported beside the lines that did come
 * back.
 *
 * M1's flat `events.ndjson` is read FIRST, as the oldest day. Nothing writes it
 * any more, but there is real history in such files on this machine, and the
 * journal is the one thing no later version can go back for (§10.1а). Its lines
 * carry no `seq`, so they take no part in gap detection.
 */
export async function readJournal(
  layout: StorageLayout,
  terminalId: TerminalId
): Promise<JournalRead> {
  const lines: JournalLine[] = [];
  const unreadableFiles: string[] = [];
  let unreadableLines = 0;

  for (const path of await journalPaths(layout, terminalId)) {
    const read = await readText(path);
    if (read.kind === 'refused') {
      unreadableFiles.push(path);
      continue;
    }
    if (read.kind === 'absent') {
      // The ordinary state of M1's flat file on a terminal that never had one.
      continue;
    }
    for (const text of linesOf(read.text)) {
      const decoded = decodeJournalLine(text);
      if (decoded.kind === 'line') {
        lines.push(decoded.line);
      } else {
        unreadableLines += 1;
      }
    }
  }

  return { lines, gaps: gapsIn(lines), unreadableLines, unreadableFiles };
}

/**
 * How much of a file's end is read to find its last lines.
 *
 * A ceiling and not a promise about how many lines come back: with texts kept
 * out of the journal (the default) a line is a few hundred bytes, so a window
 * this size holds thousands of them. It exists because this read runs AGAIN
 * every time an event reaches the terminal a person is looking at, and a cost
 * that grows with the history is a panel that gets slower the longer somebody
 * works.
 */
/** The line separator the journal is written with. */
const NEWLINE = '\n';

const BYTES_PER_KB = 1024;
const KB_PER_MB = 1024;

export const JOURNAL_TAIL_WINDOW_BYTES = BYTES_PER_KB * KB_PER_MB;

export interface JournalTail {
  /** Oldest first, and never more than the caller asked for. */
  readonly lines: readonly JournalLine[];
  /** Holes WITHIN a file. See `readJournalTail` for why not across them. */
  readonly gaps: readonly JournalGap[];
  readonly unreadableLines: number;
  readonly unreadableFiles: readonly string[];
  /** What the read cost, so that "bounded" is a measurement rather than a claim. */
  readonly bytesRead: number;
}

/**
 * The end of one terminal's history: at most `limit` lines, newest last.
 *
 * A second reader beside `readJournal` rather than a `slice` of it, and the two
 * differences are the whole reason it exists.
 *
 * **It is bounded.** Files are opened newest first and only their last
 * `JOURNAL_TAIL_WINDOW_BYTES` are read, stopping as soon as there are enough
 * lines. The panel calls this on every event that reaches the terminal it is
 * showing; `readJournal` reads every day the retention kept, which is the right
 * answer for a projector rebuilding a state and the wrong one for a list of
 * twenty lines.
 *
 * **It does not compare numbering across files.** The writer starts every day's
 * file at one, so the last line of Monday and the first of Tuesday are 40 and 1
 * -- which `readJournal` reports as a break in the sequence, correctly by its
 * own contract and uselessly for a person: every journal older than a day would
 * carry a warning. Within a file the counter is one unbroken run, and a hole in
 * it is a real one.
 *
 * Never throws, for the same reason `readJournal` does not: a history is read
 * to answer a question, and a read that fails wholesale answers nothing.
 */
export async function readJournalTail(
  layout: StorageLayout,
  terminalId: TerminalId,
  limit: number
): Promise<JournalTail> {
  const paths = await journalPaths(layout, terminalId);
  const unreadableFiles: string[] = [];
  /** One entry per file that gave lines, newest file first. */
  const perFile: JournalLine[][] = [];
  let unreadableLines = 0;
  let bytesRead = 0;
  let kept = 0;

  for (const path of [...paths].reverse()) {
    if (kept >= limit) {
      break;
    }
    const read = await readTail(path, JOURNAL_TAIL_WINDOW_BYTES);
    if (read.kind === 'refused') {
      unreadableFiles.push(path);
      continue;
    }
    if (read.kind === 'absent') {
      continue;
    }
    bytesRead += read.bytesRead;
    const lines: JournalLine[] = [];
    for (const text of linesOf(read.text)) {
      const decoded = decodeJournalLine(text);
      if (decoded.kind === 'line') {
        lines.push(decoded.line);
      } else {
        unreadableLines += 1;
      }
    }
    if (lines.length === 0) {
      continue;
    }
    perFile.push(lines);
    kept += lines.length;
  }

  // The oldest file is the one that overshot, so it is the one trimmed.
  const oldest = perFile.at(-1);
  if (oldest !== undefined && kept > limit) {
    perFile[perFile.length - 1] = oldest.slice(kept - limit);
  }
  const oldestFirst = [...perFile].reverse();

  return {
    lines: oldestFirst.flat(),
    gaps: oldestFirst.flatMap((lines) => gapsIn(lines)),
    unreadableLines,
    unreadableFiles,
    bytesRead,
  };
}

type TailRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text', readonly text: string, readonly bytesRead: number }
  | { readonly kind: 'refused' };

/**
 * The last `window` bytes of a file, with the fragment at the front dropped.
 *
 * A window that did not start at byte zero begins in the middle of a line, and
 * that fragment is thrown away rather than decoded: at best it is an unreadable
 * line reported in a healthy journal, at worst it is a plausible one. It is
 * also where a multi-byte character can be cut in half, and dropping the
 * fragment deals with both at once.
 */
async function readTail(path: string, window: number): Promise<TailRead> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (cause: unknown) {
    return (cause as { readonly code?: unknown }).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'refused' };
  }
  try {
    const stats = await handle.stat();
    // A directory named like a journal file opens without complaint on this
    // platform and stats as empty, which would make it indistinguishable from a
    // day nothing was written to. `readJournal` reports it because `readFile`
    // refuses it; this reader has to ask.
    if (!stats.isFile()) {
      return { kind: 'refused' };
    }
    const { size } = stats;
    const start = Math.max(0, size - window);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return {
      kind: 'text',
      text: start === 0 ? text : text.slice(text.indexOf(NEWLINE) + 1),
      bytesRead: length,
    };
  } catch {
    // NOT EXERCISED BY THE SUITE, and said so rather than left to be found: a
    // read that fails after the file opened is an I/O fault, and this suite has
    // no portable way to stage one. It is here because the alternative is a
    // throw out of a panel redraw.
    return { kind: 'refused' };
  } finally {
    await handle.close();
  }
}

/**
 * The highest number in one journal file, or `0` when there is nothing to
 * continue from.
 *
 * The writer asks this when it first touches a day's file, rather than keeping a
 * counter of its own: the counter would be wrong after every restart, after
 * every adoption of a terminal by another window, and on any machine that came
 * back to a day it had already written (see `journalDay`). The file itself is
 * the only thing that knows.
 *
 * A file that cannot be read answers `0`, and the consequence is named rather
 * than hidden: numbering restarts, and the reader above reports that as a gap.
 */
export async function lastSequenceIn(path: string): Promise<number> {
  const read = await readText(path);
  if (read.kind !== 'text') {
    return 0;
  }

  let last = 0;
  for (const text of linesOf(read.text)) {
    const decoded = decodeJournalLine(text);
    if (decoded.kind === 'line' && decoded.line.seq !== null && decoded.line.seq > last) {
      last = decoded.line.seq;
    }
  }
  return last;
}

/** Oldest first: M1's flat file, then a file per day in the order their names sort. */
async function journalPaths(
  layout: StorageLayout,
  terminalId: TerminalId
): Promise<readonly string[]> {
  return [layout.legacyJournalFile(terminalId), ...(await journalDayFiles(layout, terminalId))];
}

export async function journalDayFiles(
  layout: StorageLayout,
  terminalId: TerminalId
): Promise<readonly string[]> {
  const directory = layout.eventsDir(terminalId);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    // No `events/` is a terminal that has not been written to yet, which is the
    // ordinary state of a terminal being created.
    return [];
  }
  // Filtered by NAME and not by type on purpose: something shaped like a
  // journal file and not readable as one is an anomaly to report, not one to
  // step over in silence.
  return names
    .filter((name) => isJournalFileName(name))
    .sort()
    .map((name) => join(directory, name));
}

type TextRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text', readonly text: string }
  | { readonly kind: 'refused' };

async function readText(path: string): Promise<TextRead> {
  try {
    return { kind: 'text', text: await readFile(path, 'utf8') };
  } catch (cause: unknown) {
    return (cause as { readonly code?: unknown }).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'refused' };
  }
}

function linesOf(text: string): readonly string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

function gapsIn(lines: readonly JournalLine[]): readonly JournalGap[] {
  const gaps: JournalGap[] = [];
  let previous: number | null = null;
  for (const line of lines) {
    const { seq } = line;
    if (seq === null) {
      continue;
    }
    if (previous !== null && seq !== previous + 1) {
      gaps.push({ expected: previous + 1, found: seq });
    }
    previous = seq;
  }
  return gaps;
}
