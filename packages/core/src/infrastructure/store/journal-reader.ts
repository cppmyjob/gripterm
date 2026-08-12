import { readFile, readdir } from 'node:fs/promises';
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
