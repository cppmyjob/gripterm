import type { TerminalEntry } from '../entities/terminal-entry';
import type { PersistedTerminalState } from '../entities/terminal-state';

/**
 * The one line the status bar shows.
 *
 * `null` from `summariseTerminals` means "show nothing at all": an extension
 * that occupies a slot in every window it is installed in, saying zero, is the
 * behaviour people uninstall extensions for.
 */
export interface StatusSummary {
  /** Includes a `$(codicon)` at the front -- the status bar renders those inline. */
  readonly text: string;
  readonly tooltipLines: readonly string[];
  /** True when something is blocked on the person. The host paints this as a warning. */
  readonly alert: boolean;
}

/** States where the agent has stopped and is waiting for a human. */
const BLOCKING: ReadonlySet<PersistedTerminalState> = new Set<PersistedTerminalState>([
  'waiting_permission',
  'waiting_input',
]);

/** States where the agent is doing something and nobody needs to look. */
const BUSY: ReadonlySet<PersistedTerminalState> = new Set<PersistedTerminalState>([
  'launching',
  'working',
]);

/** States that mean the terminal is over; they are counted nowhere and shown nowhere. */
const OVER: ReadonlySet<PersistedTerminalState> = new Set<PersistedTerminalState>([
  'ended',
  'orphaned',
  'resume_failed',
]);

/**
 * Everything this window is running, in one line.
 *
 * The rule behind the wording: the status bar answers ONE question -- "is
 * anything waiting for me" -- and it answers it in the first two characters,
 * because that is all a person spends on it. Counts of everything else belong
 * in the tooltip, where somebody who wants them has already stopped to look.
 *
 * Terminals that are over are excluded from the count rather than shown as a
 * separate number. A record kept for its history is not a thing you can be
 * behind on, and a count that only grows is a count people stop reading.
 */
export function summariseTerminals(entries: readonly TerminalEntry[]): StatusSummary | null {
  const active = entries.filter(
    (entry) => entry.isRestorable() && !OVER.has(entry.observed.state)
  );
  if (active.length === 0) {
    return null;
  }

  const blocked = active.filter((entry) => BLOCKING.has(entry.observed.state));
  const busy = active.filter((entry) => BUSY.has(entry.observed.state));

  return {
    text: headline(blocked.length, busy.length, active.length),
    tooltipLines: counts(active),
    alert: blocked.length > 0,
  };
}

function headline(blocked: number, busy: number, active: number): string {
  if (blocked > 0) {
    return `$(shield) ${blocked} waiting for you`;
  }
  if (busy > 0) {
    return `$(sync~spin) ${busy} working`;
  }
  return `$(check) ${active} idle`;
}

/** One line per state that actually occurs, most numerous first, so the tooltip stays short. */
function counts(active: readonly TerminalEntry[]): readonly string[] {
  const tally = new Map<PersistedTerminalState, number>();
  for (const entry of active) {
    tally.set(entry.observed.state, (tally.get(entry.observed.state) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([state, count]) => `${count} ${state.replaceAll('_', ' ')}`);
}
