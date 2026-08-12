import type { OwnerLiveness } from '../ports/owner-presence';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalState } from '../entities/terminal-state';

/**
 * How one terminal looks in a list.
 *
 * Strings and ids, no editor objects. The table below is the whole of what
 * "icon and colour for every state" means, and it lives here rather than in the
 * tree view for one reason: `packages/extension` is deliberately outside the
 * coverage thresholds (§3.5), so a decision taken there is a decision nothing
 * checks. What remains on the other side is `new vscode.ThemeIcon(iconId)`.
 */
export interface TerminalPresentation {
  /** The state as SHOWN -- which is the stored state with `detached` laid over it. */
  readonly state: TerminalState;
  readonly label: string;
  readonly description: string;
  readonly tooltipLines: readonly string[];
  readonly iconId: string;
  /**
   * The STATE's colour, for the icon. A theme colour id, or `null` to leave the
   * host's default.
   */
  readonly colorId: string | null;
  /**
   * The PERSON's colour, for the row's label. `null` when they set none.
   *
   * Two colours on one row, and keeping them on separate surfaces is the whole
   * design rather than a detail of drawing. Colour is what a person scans a list
   * with, and the icon's colour answers "does this one need me" -- which is the
   * question П1 exists about. A personal colour laid over that would trade the
   * only automatic signal on the row for a manual one, quietly, for whoever
   * happened to use the feature. So the icon stays the tool's judgement and the
   * label becomes the person's filing.
   */
  readonly labelColorId: string | null;
  /** What a menu's `when` clause tests. See `CONTEXT_LIVE`. */
  readonly contextValue: string;
}

/**
 * A terminal this window can still act on: focus it, close it, send it work.
 * Menus keyed on this get commands that do something.
 */
export const CONTEXT_LIVE = 'gripterm.terminal.live';

/**
 * A record whose terminal is gone. Focusing it would be a no-op, so the menus
 * keyed on this offer what is left: the journal, the record, starting over.
 */
export const CONTEXT_OVER = 'gripterm.terminal.over';

/**
 * A record another window owns, whose window is still there.
 *
 * Nothing is offered on it, and that is the point: the terminal is alive and
 * working, but it lives in a window this one cannot reach -- `focus` would raise
 * nothing and `close` would be a write into a record this window is forbidden to
 * write (§4.8). A button that does nothing teaches a person that the whole list
 * is decorative.
 *
 * A foreign record whose owner is GONE does not get this value: it gets
 * `CONTEXT_OVER` by way of `detached`, which is the state that means "there is
 * something to be done here" -- restoring it (M2.10).
 */
export const CONTEXT_FOREIGN = 'gripterm.terminal.foreign';

interface StateAppearance {
  readonly iconId: string;
  readonly colorId: string | null;
  /** What the state is called in front of a person. */
  readonly words: string;
  /** Whether this window can still act on the terminal. */
  readonly live: boolean;
}

/**
 * Every state, spelled out.
 *
 * A total record, so a new member of `TerminalState` breaks the build here
 * instead of arriving on screen as a blank row with no icon. Three choices in
 * it are deliberate rather than decorative:
 *
 *   * the two states with a spinner are the two where something is HAPPENING;
 *     a static icon for `working` makes a stuck turn indistinguishable from a
 *     running one at a glance, which is the whole complaint П1 is about;
 *   * the two blocking states share one colour, because the question the person
 *     is scanning for is "does this one need me", not "which kind of need";
 *   * `ended` is the only entry that gives up its colour. A finished terminal
 *     that still draws the eye is noise in a list whose job is to show the ones
 *     that do not.
 */
const APPEARANCE: Readonly<Record<TerminalState, StateAppearance>> = {
  launching: { iconId: 'loading~spin', colorId: 'charts.blue', words: 'starting', live: true },
  idle: { iconId: 'check', colorId: 'charts.green', words: 'idle', live: true },
  working: { iconId: 'sync~spin', colorId: 'charts.blue', words: 'working', live: true },
  waiting_permission: {
    iconId: 'shield',
    colorId: 'charts.yellow',
    words: 'waiting for permission',
    live: true,
  },
  waiting_input: {
    iconId: 'comment-discussion',
    colorId: 'charts.yellow',
    words: 'waiting for input',
    live: true,
  },
  turn_failed: { iconId: 'warning', colorId: 'charts.orange', words: 'turn failed', live: true },
  degraded: { iconId: 'question', colorId: 'charts.orange', words: 'state unknown', live: true },
  orphaned: {
    iconId: 'debug-disconnect',
    colorId: 'charts.orange',
    words: 'no process',
    live: false,
  },
  ended: { iconId: 'circle-slash', colorId: 'disabledForeground', words: 'ended', live: false },
  resume_failed: { iconId: 'error', colorId: 'charts.red', words: 'restore failed', live: false },
  detached: { iconId: 'plug', colorId: 'disabledForeground', words: 'detached', live: false },
};

/** Long enough to recognise the answer, short enough not to become the row. */
const MESSAGE_LIMIT = 160;

/**
 * What the list knows about a row that the record itself does not carry.
 *
 * Both default to the answer that was true while the base had exactly one
 * owner, so a caller that has neither still gets a truthful row.
 */
export interface PresentationContext {
  /**
   * The OWNER's liveness, not the terminal's. Computed by the reconciler
   * (M2.12) and never stored: only a foreign process could write `detached`
   * into a file it does not own, and an overlay is free to undo -- once the
   * heartbeat is fresh again it simply stops applying (§4.3).
   */
  readonly liveness?: OwnerLiveness;
  /** Whether THIS window owns the record. False for what the base projected in. */
  readonly ours?: boolean;
}

/** One entry, ready to draw. */
export function presentTerminal(
  entry: TerminalEntry,
  context: PresentationContext = {}
): TerminalPresentation {
  const liveness = context.liveness ?? 'live';
  const ours = context.ours ?? true;
  const state = displayedState(entry, liveness);
  const appearance = APPEARANCE[state];

  return {
    state,
    label: entry.metadata.displayName,
    description: description(entry, appearance),
    tooltipLines: tooltipLines(entry, appearance, ours),
    iconId: appearance.iconId,
    colorId: appearance.colorId,
    labelColorId: entry.metadata.color,
    contextValue: contextValueFor(entry, appearance, ours),
  };
}

function contextValueFor(
  entry: TerminalEntry,
  appearance: StateAppearance,
  ours: boolean
): string {
  if (!appearance.live || !entry.isRestorable()) {
    return CONTEXT_OVER;
  }
  return ours ? CONTEXT_LIVE : CONTEXT_FOREIGN;
}

function displayedState(entry: TerminalEntry, liveness: OwnerLiveness): TerminalState {
  // `unknown` is treated as `dead` for DRAWING only, and the two stay apart
  // everywhere it matters: adoption refuses `unknown` without an explicit
  // force, because a stale heartbeat is a living window often enough that
  // guessing costs a second `claude --resume` on one conversation.
  return liveness === 'live' ? entry.observed.state : 'detached';
}

function description(entry: TerminalEntry, appearance: StateAppearance): string {
  const { currentTool } = entry.observed;
  return currentTool === null ? appearance.words : `${appearance.words} · ${currentTool}`;
}

function tooltipLines(
  entry: TerminalEntry,
  appearance: StateAppearance,
  ours: boolean
): readonly string[] {
  const lines = [`${entry.metadata.displayName} — ${appearance.words}`];
  if (!ours) {
    // The row otherwise looks exactly like one of ours, and the only other sign
    // is an absence -- the buttons that are not there. An absence explains
    // nothing to the person wondering why.
    lines.push('opened in another window');
  }
  if (entry.metadata.task !== null) {
    lines.push(entry.metadata.task);
  }
  if (entry.metadata.tags.length > 0) {
    // Hashes rather than commas: a tag is read at a glance and the marker is
    // what makes the line skippable for somebody looking for the task.
    lines.push(entry.metadata.tags.map((tag) => `#${tag}`).join(' '));
  }
  appendLatestNote(entry, lines);
  lines.push(entry.launch.cwd);
  if (entry.observed.lastAssistantMessage !== null) {
    lines.push(truncate(entry.observed.lastAssistantMessage));
  }
  if (entry.observed.cost !== null) {
    lines.push(`$${entry.observed.cost.totalUsd.toFixed(2)}`);
  }
  if (entry.observed.contextWindow !== null) {
    lines.push(`context ${entry.observed.contextWindow.usedPercentage.toFixed(0)}%`);
  }
  // Last, because these are the lines a person copies rather than reads.
  appendSessions(entry, lines);
  return lines;
}

/**
 * Which conversation this terminal is having, and which one it left.
 *
 * The second line is the visible half of M2.8, and it is there for a reason
 * stronger than telling a person that `/clear` was noticed. `/clear` DESTROYS
 * nothing: the previous conversation is still in the CLI's own store and
 * `claude --resume <id>` still reaches it -- but its id is the only handle on it
 * that exists anywhere, and until this line it lived nowhere a person could see.
 * A record that quietly forgot it would make a `/clear` typed by accident
 * irreversible for the one thing in this design nothing can rebuild.
 *
 * So it is shown WHOLE, and only the most recent one is. An id is a line to copy
 * rather than to read, and a terminal cleared eleven times would otherwise turn
 * its tooltip into a column of them; the count says there is more without
 * drawing it.
 */
function appendSessions(entry: TerminalEntry, lines: string[]): void {
  lines.push(`session ${entry.sessionId.value}`);
  const { sessionIdHistory } = entry;
  const previous = sessionIdHistory.at(-1);
  if (previous === undefined) {
    return;
  }
  const older = sessionIdHistory.length - 1;
  lines.push(
    older === 0 ? `previously ${previous.value}` : `previously ${previous.value} (+${older} more)`
  );
}

/**
 * The last note, and how many there are.
 *
 * One note and not all of them: a tooltip is a glance, and a terminal somebody
 * has been thinking about for a week would otherwise draw a wall over the list
 * it is a tooltip for. The count is what stops that being a lie -- "there is
 * more here" is the part a person needs in order to go and look.
 *
 * The LAST note rather than the newest by timestamp. They are appended, so the
 * two agree; sorting by `at` would additionally have to decide what to do about
 * two notes written in the same millisecond, and would answer differently on
 * different days for the same record.
 */
function appendLatestNote(entry: TerminalEntry, lines: string[]): void {
  const { notes } = entry.metadata;
  const latest = notes.at(-1);
  if (latest === undefined) {
    return;
  }
  const text = truncate(latest.text);
  lines.push(notes.length === 1 ? text : `${text} (${notes.length} notes)`);
}

/**
 * Cuts on characters, not on words.
 *
 * An assistant message is prose we did not write, in a language we do not know,
 * and a "clever" cut on the last space turns a message with no spaces -- a
 * path, a stack trace, Chinese -- into either nothing or the whole thing.
 */
function truncate(message: string): string {
  const flattened = message.replaceAll(/\s+/gu, ' ').trim();
  return flattened.length <= MESSAGE_LIMIT
    ? flattened
    : `${flattened.slice(0, MESSAGE_LIMIT)}…`;
}
