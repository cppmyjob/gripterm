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
   * One or two characters for the editor's tab, where an icon cannot go. See
   * `StateAppearance.badge`.
   */
  readonly badge: string;
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
  /**
   * Whether a click on the row itself should open this terminal.
   *
   * True for exactly the rows a menu can act on, and that identity is the rule:
   * a click is the same offer the buttons make, made without having to hover.
   * Everything else -- a terminal that is over, one that lives in another
   * window, one whose window has gone -- has nothing to show, and a click that
   * did nothing would teach a person that clicking rows does nothing.
   */
  readonly opens: boolean;
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
 * A record another window owns AND IS ANSWERING FOR, which this window may only
 * read.
 *
 * Nothing is offered on it, and that is the point: the terminal is alive and
 * working, but it lives in a window this one cannot reach -- `focus` would raise
 * nothing and `close` would be a write into a record this window is forbidden to
 * write (§4.8). A button that does nothing teaches a person that the whole list
 * is decorative.
 *
 * **The owner's liveness is the whole of the condition (M2.22).** Until then a
 * record whose terminal had been closed kept this value even once its window was
 * gone -- there was nothing to adopt, so the row offered nothing at all, to
 * nobody, for ever. That is a row a person cannot get rid of, which is what the
 * owner reported on 2026-08-13. See `CONTEXT_ABANDONED`.
 */
export const CONTEXT_FOREIGN = 'gripterm.terminal.foreign';

/**
 * A record another window owns and NOBODY is answering for: its window is gone,
 * or there and silent.
 *
 * The row nothing else in this build was ever going to resolve. Restoring it is
 * refused for a reason that does not change -- its terminal was closed, or
 * nothing was ever said in its conversation, which is what a `Start Over` left
 * behind by a window that then went away looks like -- so adoption has nothing
 * to offer and the automatic cleanup deliberately leaves some of them alone
 * (`UNASKED`). What is left to do with such a record is to throw it away, and
 * this value is what lets the manifest offer that on the row itself instead of
 * in a command in the title of the view.
 *
 * **It is not "rubbish", it is "unattended".** The record may carry a name, a
 * task and notes somebody wrote, so nothing acts on this value by itself: it
 * only makes a menu entry appear, and what that entry does is modal, reversible
 * and says whose window it belonged to.
 */
export const CONTEXT_ABANDONED = 'gripterm.terminal.abandoned';

/**
 * A record another window owns, whose window is gone or has stopped answering.
 *
 * The one row where this window may act on somebody else's record, and it may
 * do exactly one thing: take it, which is `gripterm.adoptTerminal` (M2.14).
 * Adoption is never automatic across projects -- §6 keeps the restore predicate
 * to this window's own folders, and this value is the manual branch that keeps
 * everything else from freezing for ever.
 *
 * One value for both `detached` and `unreachable`, deliberately. The difference
 * between them decides how hard the command asks, and asking is done with the
 * liveness read at the moment of the click -- a `contextValue` computed when the
 * row was drawn would be a stale answer to that question.
 */
export const CONTEXT_ADOPTABLE = 'gripterm.terminal.adoptable';

interface StateAppearance {
  readonly iconId: string;
  /**
   * One or two characters for the editor's TAB, where an icon cannot go.
   *
   * The customer's third complaint (2026-08-21): the state is in the tree and
   * not on the tab. The editor offers no way to change a terminal's icon after
   * it is made and renames only the ACTIVE terminal, so the one thing that
   * reaches a tab is a file decoration -- a badge of at most two characters and
   * a colour. Three characters are silently cut off, and a badge that is cut
   * off is a state a person cannot read.
   */
  readonly badge: string;
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
  launching: { iconId: 'loading~spin', badge: '↻', colorId: 'charts.blue', words: 'starting', live: true },
  idle: { iconId: 'check', badge: '✓', colorId: 'charts.green', words: 'idle', live: true },
  working: { iconId: 'sync~spin', badge: '●', colorId: 'charts.blue', words: 'working', live: true },
  waiting_permission: {
    iconId: 'shield',
    badge: '!',
    colorId: 'charts.yellow',
    words: 'waiting for permission',
    live: true,
  },
  waiting_input: {
    iconId: 'comment-discussion',
    badge: '?',
    colorId: 'charts.yellow',
    words: 'waiting for input',
    live: true,
  },
  turn_failed: { iconId: 'warning', badge: '⨯', colorId: 'charts.orange', words: 'turn failed', live: true },
  degraded: { iconId: 'question', badge: '~', colorId: 'charts.orange', words: 'state unknown', live: true },
  orphaned: {
    iconId: 'debug-disconnect',
    badge: '⊘',
    colorId: 'charts.orange',
    words: 'no process',
    live: false,
  },
  ended: { iconId: 'circle-slash', badge: '–', colorId: 'disabledForeground', words: 'ended', live: false },
  resume_failed: { iconId: 'error', badge: '⚠', colorId: 'charts.red', words: 'restore failed', live: false },
  detached: { iconId: 'plug', badge: '≠', colorId: 'disabledForeground', words: 'detached', live: false },
  unreachable: {
    iconId: 'eye-closed',
    badge: '∅',
    colorId: 'disabledForeground',
    words: 'window not answering',
    live: false,
  },
};

/**
 * What a state is called in front of a person.
 *
 * Exported so that the details half of the panel (M3.11) can say the state in
 * the same words the tree says it, without a second copy of the table and
 * without the tool and the window that `description` adds to it -- the half
 * shows those as lines of their own.
 */
export function stateWords(state: TerminalState): string {
  return APPEARANCE[state].words;
}

/**
 * Whether a terminal in this state is one this window can still act on.
 *
 * The same field the row is drawn from, read out for the one caller that has to
 * agree with the row and lives on the other side of the list: `discard` refuses
 * to throw a record away while its conversation is running, and "running" has
 * to mean here exactly what it means on the row -- or the person is offered
 * Delete on a row whose Delete then refuses.
 *
 * That is not hypothetical. It was reported on 2026-08-22 and reproduced by the
 * owner in three moves: open a terminal, close it without typing anything, wait
 * for the row to say `no process`, press Delete. The record said `orphaned`, so
 * the row was over and the menu offered Delete and NOT Close; the refusal asked
 * a different question -- "is this window still holding a terminal object" --
 * answered yes, and told the person to close a terminal the row gave them no
 * way to close. Resume refused it too, because a watched terminal cannot be
 * started twice. Every act on that row failed.
 */
export function actsOnTheTerminal(state: TerminalState): boolean {
  return APPEARANCE[state].live;
}

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
  const contextValue = contextValueFor(entry, appearance, ours, liveness);

  return {
    state,
    label: entry.metadata.displayName,
    description: description(entry, appearance, !ours && liveness === 'live'),
    tooltipLines: tooltipLines(entry, appearance, ours),
    iconId: appearance.iconId,
    badge: appearance.badge,
    colorId: appearance.colorId,
    labelColorId: entry.metadata.color,
    contextValue,
    opens: contextValue === CONTEXT_LIVE,
  };
}

/**
 * What a menu may offer on this row, which is the whole of "read-only mode".
 *
 * Ownership is asked FIRST, because it is the rule and the rest is detail: a
 * record this window does not own is one it may not write (§4.8). Then the
 * OWNER'S LIVENESS, and that order is M2.22's correction: a foreign record whose
 * window is there belongs to that window whatever state it is in, and a foreign
 * record whose window is not there belongs to nobody -- so the last question,
 * whether there is a conversation to bring back, decides between taking it over
 * and throwing it away rather than between an offer and silence.
 */
function contextValueFor(
  entry: TerminalEntry,
  appearance: StateAppearance,
  ours: boolean,
  liveness: OwnerLiveness
): string {
  if (!ours) {
    if (liveness === 'live') {
      return CONTEXT_FOREIGN;
    }
    return entry.isRestorable() ? CONTEXT_ADOPTABLE : CONTEXT_ABANDONED;
  }
  if (!appearance.live || !entry.isRestorable()) {
    return CONTEXT_OVER;
  }
  return CONTEXT_LIVE;
}

/**
 * The stored state, with the owner's liveness laid over it.
 *
 * The two overlays are kept apart here rather than merged into one "not live",
 * because the difference is exactly what the next click costs: `detached` is a
 * window that has gone, and taking its record is ordinary; `unreachable` is a
 * window that is there and silent -- asleep, or stalled -- and taking its record
 * is a second `claude --resume` on a conversation that already has one unless
 * the person has looked. Drawing them alike would ask for that risk without
 * mentioning it.
 */
function displayedState(entry: TerminalEntry, liveness: OwnerLiveness): TerminalState {
  switch (liveness) {
    case 'live':
      return entry.observed.state;
    case 'dead':
      return 'detached';
    default:
      return 'unreachable';
  }
}

/**
 * The dim half of the row: what it is doing, and whose it is.
 *
 * The last part is only added while the owning window is LIVE, and that is the
 * case it exists for: two editors open on one folder put both terminals under
 * one heading, where the only other sign that one of them is not ours is the
 * absence of buttons -- which the platform shows on hover. Once the owner stops
 * answering the state itself says it (`detached`, `unreachable` are never rows
 * of ours), and a second sign would only make the line longer.
 */
function description(
  entry: TerminalEntry,
  appearance: StateAppearance,
  elsewhere: boolean
): string {
  const { currentTool } = entry.observed;
  const parts = [appearance.words];
  if (currentTool !== null) {
    parts.push(currentTool);
  }
  if (elsewhere) {
    parts.push('other window');
  }
  return parts.join(' · ');
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
