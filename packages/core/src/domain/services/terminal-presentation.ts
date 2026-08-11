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
  /** A theme colour id, or `null` to leave the host's default. */
  readonly colorId: string | null;
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
 * One entry, ready to draw.
 *
 * `liveness` is the OWNER's, not the terminal's, and it is the only input that
 * is not part of the record. This is the single place `detached` is applied:
 * it is never stored, because only a foreign process could write it into a file
 * it does not own, and the overlay is free to undo -- once the heartbeat is
 * fresh again it simply stops applying (§4.3).
 *
 * In M1 nothing supplies it: the base has exactly one owner, so the default is
 * the truthful answer. The reconciler that computes it arrives in M2.12.
 */
export function presentTerminal(
  entry: TerminalEntry,
  liveness: OwnerLiveness = 'live'
): TerminalPresentation {
  const state = displayedState(entry, liveness);
  const appearance = APPEARANCE[state];

  return {
    state,
    label: entry.metadata.displayName,
    description: description(entry, appearance),
    tooltipLines: tooltipLines(entry, appearance),
    iconId: appearance.iconId,
    colorId: appearance.colorId,
    contextValue: appearance.live && entry.isRestorable() ? CONTEXT_LIVE : CONTEXT_OVER,
  };
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

function tooltipLines(entry: TerminalEntry, appearance: StateAppearance): readonly string[] {
  const lines = [`${entry.metadata.displayName} — ${appearance.words}`];
  if (entry.metadata.task !== null) {
    lines.push(entry.metadata.task);
  }
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
  // Last, because it is the line a person copies rather than reads.
  lines.push(`session ${entry.sessionId.value}`);
  return lines;
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
