import { presentTerminal, stateWords } from './terminal-presentation';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalEvent } from '../events/terminal-event';

/**
 * The details half of the panel: everything this build knows about the terminal
 * on the left, as words.
 *
 * It is a rule and not a drawing, for the same reason the strip is one, and for
 * one more that is particular to this half. The strip can be wrong about a name;
 * this half claims to say what Gripterm KNOWS, and the ways for that claim to
 * be false are not visible in a screenshot: a history with a hole drawn as an
 * unbroken one, a line this build cannot read left out of the list, texts
 * missing because a policy dropped them rather than because nothing was said.
 * Every one of those is a sentence here, and every sentence has a test.
 *
 * **Nothing is invented.** The state, its icon and its colour come from
 * `presentTerminal` -- the same rule the tree draws its rows with and the strip
 * draws its tabs with -- so a terminal cannot be `working` on its tab and
 * `idle` in its details. What this file adds is the two things only the panel
 * knows (which terminal is on screen and whether it still has a process) and
 * the history, which nothing else in this build reads at all.
 *
 * **Times are numbers here and words in the page.** Formatting a moment is a
 * question about a person's locale and time zone, and the document is where
 * that is known; a rule that formatted them would be deciding it for everyone
 * in a unit test.
 */

/**
 * How many events of the history the half shows.
 *
 * The tail rather than the whole: a journal is kept for a fortnight (§4.8) and a
 * busy terminal writes thousands of lines into it, while this half exists to
 * answer "what has been happening" at a glance. The cap is applied HERE as well
 * as in the reader, so the promise holds however much a caller hands over.
 */
export const DETAILS_EVENT_LIMIT = 20;

/**
 * How much of the agent's last answer is shown.
 *
 * Longer than the tooltip's 160, because this half is read rather than glanced
 * at, and still bounded: an answer with a stack trace in it would otherwise push
 * everything else in the half off the screen.
 */
const ANSWER_LIMIT = 400;

/** One line of the history, as the reader hands it over. */
export interface HistoryEvent {
  readonly atMs: number;
  /** What the line turned out to be, or `null` when this build cannot read it. */
  readonly event: TerminalEvent | null;
  /** Names of the fields redaction removed. Names only -- that is the point. */
  readonly dropped: readonly string[];
}

/**
 * The shown terminal's history, and the health of the read that produced it.
 *
 * The three counts travel with the lines rather than beside them because a
 * reader that dropped them would be handing over a history that looks complete.
 */
export interface JournalHistory {
  /** Oldest first, as the journal has them. */
  readonly events: readonly HistoryEvent[];
  /** Holes in the numbering: lines were written that these files do not have. */
  readonly gaps: number;
  readonly unreadableLines: number;
  readonly unreadableFiles: number;
  /** False before the first read comes back -- a state, not an empty history. */
  readonly read: boolean;
}

export interface DetailsInput {
  /** Every terminal the panel is holding, in the order it took them. */
  readonly held: readonly string[];
  /** The one on screen, or `null` when the panel is showing none of them. */
  readonly shown: string | null;
  /** Those of them that still have a process. */
  readonly running: readonly string[];
  /** What this window knows about its terminals. The shown one may be missing. */
  readonly entries: readonly TerminalEntry[];
  /** The tail of the SHOWN terminal's journal. */
  readonly history: JournalHistory;
}

/** The name of the terminal and what it is doing, drawn as the tree draws it. */
export interface DetailsHeadline {
  readonly terminalId: string;
  readonly label: string;
  /** The state in the words a person reads. */
  readonly words: string;
  readonly iconId: string;
  readonly colorId: string | null;
  /** Whether the process behind it is gone. */
  readonly over: boolean;
}

/** One line of the record: a name a person scans for and a value they read. */
export interface DetailsFact {
  readonly name: string;
  readonly value: string;
}

export interface DetailsNote {
  readonly atMs: number;
  readonly text: string;
}

export interface DetailsEvent {
  readonly atMs: number;
  readonly words: string;
}

export interface DetailsView {
  /**
   * What to say when there is nothing to describe, or `null` when there is.
   *
   * Said in words rather than left blank, which is the plan's own line for this
   * half: an empty rectangle reads as a defect, and a sentence reads as a state.
   */
  readonly nothing: string | null;
  readonly headline: DetailsHeadline | null;
  readonly facts: readonly DetailsFact[];
  readonly startedAtMs: number | null;
  readonly lastEventAtMs: number | null;
  readonly task: string | null;
  /** Newest first: a note is written to be read next, not in the order it was made. */
  readonly notes: readonly DetailsNote[];
  /** Oldest first, so the newest is at the bottom where a log is read. */
  readonly events: readonly DetailsEvent[];
  /** Everything the half must say about the history it is showing. */
  readonly notices: readonly string[];
}

const NO_TERMINALS =
  'No terminal in this panel yet. Run "Gripterm: New Terminal" to start one.';
const NONE_SHOWN = 'No terminal is on screen. Click a tab above to pick one.';
const NO_RECORD =
  'This window is holding this terminal but has no record of it, so there is nothing to say about it.';
const UNREAD = 'Reading this terminal’s history…';
const NO_HISTORY = 'Nothing has been written to this terminal’s journal yet.';
const REDACTED =
  'Texts are not kept in the journal: gripterm.journal.includeContent is off.';

const NOTHING: DetailsView = {
  nothing: NO_TERMINALS,
  headline: null,
  facts: [],
  startedAtMs: null,
  lastEventAtMs: null,
  task: null,
  notes: [],
  events: [],
  notices: [],
};

/**
 * The details half, from what the panel holds and what the window knows.
 *
 * A held terminal with no record is DESCRIBED rather than skipped, in the same
 * spirit as the tab that stays on the strip: a person looking at a screen with
 * a terminal on it needs to be told why the half beside it is empty, and "no
 * record" is a defect somewhere else that this half is the only place to see.
 */
export function describeTerminal(input: DetailsInput): DetailsView {
  if (input.held.length === 0) {
    return NOTHING;
  }
  const shown = input.shown;
  if (shown === null) {
    return { ...NOTHING, nothing: NONE_SHOWN };
  }

  const over = !input.running.includes(shown);
  const entry = input.entries.find((candidate) => candidate.terminalId.value === shown);
  const events = eventsOf(input.history);
  const notices = noticesOf(input.history, entry === undefined);

  if (entry === undefined) {
    return {
      nothing: null,
      headline: { terminalId: shown, label: 'terminal', words: 'unknown', iconId: 'question', colorId: null, over },
      facts: [],
      startedAtMs: null,
      lastEventAtMs: null,
      task: null,
      notes: [],
      events,
      notices,
    };
  }

  const shownAs = presentTerminal(entry);
  return {
    nothing: null,
    headline: {
      terminalId: shown,
      label: shownAs.label,
      words: stateWords(shownAs.state),
      iconId: shownAs.iconId,
      colorId: shownAs.colorId,
      over,
    },
    facts: factsOf(entry),
    startedAtMs: entry.createdAt.getTime(),
    lastEventAtMs: entry.observed.lastEventAt.getTime(),
    task: entry.metadata.task,
    notes: [...entry.metadata.notes]
      .reverse()
      .map((note) => ({ atMs: note.at.getTime(), text: note.text })),
    events,
    notices,
  };
}

/**
 * The record, as lines.
 *
 * Absent fields are LEFT OUT rather than drawn empty: a column of names against
 * blanks is read as a build that lost them, and the half is short enough that a
 * missing line is noticed by its absence.
 */
function factsOf(entry: TerminalEntry): readonly DetailsFact[] {
  const facts: DetailsFact[] = [];
  const { observed } = entry;
  if (observed.currentTool !== null) {
    facts.push({ name: 'tool', value: observed.currentTool });
  }
  facts.push({ name: 'folder', value: entry.launch.cwd });
  if (observed.pid !== null) {
    facts.push({ name: 'process', value: String(observed.pid) });
  }
  facts.push({ name: 'engine', value: entry.engine });
  if (observed.cost !== null) {
    facts.push({ name: 'cost', value: `$${observed.cost.totalUsd.toFixed(2)}` });
  }
  if (observed.contextWindow !== null) {
    facts.push({
      name: 'context',
      value: `${observed.contextWindow.usedPercentage.toFixed(0)}% used`,
    });
  }
  if (observed.lastAssistantMessage !== null) {
    facts.push({ name: 'last answer', value: shorten(observed.lastAssistantMessage) });
  }
  // Last, and in this order, because these are the lines a person copies rather
  // than reads -- and because `previously` is the only handle that exists
  // anywhere on the conversation a `/clear` left behind (M2.8).
  facts.push({ name: 'session', value: entry.sessionId.value });
  const previous = entry.sessionIdHistory.at(-1);
  if (previous !== undefined) {
    const older = entry.sessionIdHistory.length - 1;
    facts.push({
      name: 'previously',
      value: older === 0 ? previous.value : `${previous.value} (+${String(older)} more)`,
    });
  }
  return facts;
}

function shorten(text: string): string {
  return text.length <= ANSWER_LIMIT ? text : `${text.slice(0, ANSWER_LIMIT)}…`;
}

function eventsOf(history: JournalHistory): readonly DetailsEvent[] {
  return history.events
    .slice(-DETAILS_EVENT_LIMIT)
    .map((line) => ({ atMs: line.atMs, words: wordsFor(line.event) }));
}

function noticesOf(history: JournalHistory, unknown: boolean): readonly string[] {
  const notices: string[] = [];
  if (unknown) {
    notices.push(NO_RECORD);
  }
  if (!history.read) {
    notices.push(UNREAD);
  } else if (history.events.length === 0) {
    notices.push(NO_HISTORY);
  }
  if (history.gaps > 0) {
    notices.push(
      `${String(history.gaps)} events are missing from this history: the numbering skips them.`
    );
  }
  if (history.unreadableLines > 0) {
    notices.push(`${String(history.unreadableLines)} lines could not be read.`);
  }
  if (history.unreadableFiles > 0) {
    notices.push(`${String(history.unreadableFiles)} journal files could not be read.`);
  }
  if (history.events.some((line) => line.dropped.length > 0)) {
    notices.push(REDACTED);
  }
  return notices;
}

/**
 * One event in words.
 *
 * An exhaustive `switch` over the whole union, so an event added later breaks
 * the build here instead of arriving in a person's panel as a blank line. A
 * line this build cannot read is SHOWN as such rather than dropped: a history
 * that quietly skips what it does not understand is the one kind of history
 * nobody can act on.
 */
function wordsFor(event: TerminalEvent | null): string {
  if (event === null) {
    return 'an entry this build cannot read';
  }
  switch (event.kind) {
    case 'SessionStart':
      return `conversation started (${event.source})`;
    case 'SessionEnd':
      return `conversation ended (${event.reason})`;
    case 'UserPromptSubmit':
      return 'you sent a prompt';
    case 'PreToolUse':
      return event.toolName === null ? 'a tool started' : `${event.toolName} started`;
    case 'PostToolUse':
      return event.toolName === null ? 'a tool finished' : `${event.toolName} finished`;
    case 'PostToolUseFailure':
      return event.toolName === null ? 'a tool failed' : `${event.toolName} failed`;
    case 'PermissionRequest':
      return event.toolName === null ? 'asked for permission' : `asked to run ${event.toolName}`;
    case 'Notification':
      return `notification: ${event.notificationType}`;
    case 'Stop':
      return 'turn finished';
    case 'StopFailure':
      return event.errorType === null ? 'turn failed' : `turn failed (${event.errorType})`;
    case 'CwdChanged':
      return 'working directory changed';
    case 'ResumeTimedOut':
      return 'restoring took too long';
    case 'ProcessGone':
      return 'the process is gone';
    case 'TerminalClosed':
      return 'the terminal was closed';
    case 'LaunchExitedNonZero':
      return `the start exited with ${String(event.exitCode)}`;
    case 'ResumeExitedNonZero':
      return `the restore exited with ${String(event.exitCode)}`;
  }
}
