/**
 * How long a window may take to start, as a number the stand checks (Ш11).
 *
 * **Why it is here and not in `judge.ts`.** The nine points of ??5 are about
 * the SHAPE of the window a person comes back to -- groups, columns, the strip,
 * what came back. This is about time, it is a different question with a
 * different kind of evidence, and it has a budget document of its own that the
 * owner has never seen (`gate/allowed-red.json`). Bolting a tenth point on
 * would have put an unratified line into that document, or made every existing
 * recording `unmeasured` at a point they were never asked. So the start is
 * judged beside the nine and reported beside them, and the run is red if either
 * half is.
 *
 * **It reads what the product already prints.** `packages/extension/src/extension.ts`
 * has stamped two `tookMs` since 2026-08-22 -- one when the list reaches the
 * screen, one when activation finishes -- and until now nothing read either of
 * them. This is a reader, not a third counter.
 *
 * **Three answers, not two**, for the reason `judge.ts` gives: a run that
 * reports green for a question its recording never asked is worse than one that
 * does not run.
 */

/** What the product says when the list reaches the screen. Its own words. */
const LISTED = 'the list of terminals is on screen';
/** And when the whole of activation is done. */
const ACTIVATED = 'Gripterm activated';

export interface StartBudget {
  /** From waking up to the list being on screen. */
  readonly listedMs: number;
  /** From waking up to the end of activation: the restore and the first sweep too. */
  readonly activatedMs: number;
}

/**
 * The numbers, and where they come from.
 *
 * MEASURED, not chosen. Ш13's ceiling was first taken from the head (16), turned
 * out to be BELOW an ordinary day, and had to be replaced by a measured 32 -- so
 * this one is set from runs of the stand on this revision and from nothing else.
 *
 * THE RUNS BEHIND IT -- `pnpm run test:stand`, this machine, 2026-08-26, four
 * runs of four sittings each, after the four repairs of Ш11. Each cell is the
 * product's own two `tookMs`, as `list/activation` in milliseconds:
 *
 *     run   sitting 1     sitting 2     sitting 3     sitting 4
 *     1      889/3732      645/3103     2554/5185      385/6392
 *     2      886/3827      895/3849     3363/5915     3182/6123
 *     3      853/9426      781/3348     3369/5883     3163/5705
 *     4     1649/11194    1137/4467     2845/5117      394/6998
 *
 * Run 4 is the run whose budget was lowered on purpose, to watch this check go
 * red end to end; the numbers in it are the product's own either way, and they
 * are in the table because leaving out the run that produced the worst
 * activation of the sixteen would be picking the evidence.
 *
 * The worst sitting of the sixteen is 3 369 ms to the list and 11 194 ms to the
 * end. The budget is TWICE each, rounded up to a round number: far enough that a
 * busy machine cannot turn it red -- the same sixteen sittings spread from
 * 385 ms to 3 369 ms on one revision with nothing changed between them -- and
 * close enough that "it loads for up to a minute" cannot pass.
 *
 * **What this budget is NOT, and it matters more than what it is.** It is a
 * ceiling on THIS stand, on THIS machine, over a store of four records and one
 * window. The owner's own window on 2026-08-23 was 549 ms to the list and
 * 8 293 ms to the end -- and BOTH of those are inside the numbers below, so a
 * budget of this shape would have been green on the day the complaint was made.
 * What it catches is the start getting much worse than it is now, where nothing
 * caught anything before; what it cannot catch is a machine with many windows
 * and many records, which is the machine the complaint came from. A regression
 * of a hundred milliseconds passes it, and is meant to.
 */
export const START_BUDGET: StartBudget = {
  listedMs: 7000,
  activatedMs: 25_000,
};

/** What one sitting said about its own start. `null` is "the recording does not say". */
export interface StartReading {
  readonly sitting: number;
  readonly listedMs: number | null;
  readonly activatedMs: number | null;
}

export type StartAnswer = 'green' | 'red' | 'unmeasured';

export interface StartVerdict {
  readonly answer: StartAnswer;
  /** Why that answer, with the numbers that produced it. */
  readonly because: string;
  /**
   * How many (sitting, number) pairs went over: nought when green, and nought
   * when there was nothing to judge.
   *
   * A count and not a magnitude, the same shape and the same limitation as
   * `Finding.violations`: it moves when the fault spreads to another sitting,
   * and not when one sitting gets worse. `because` carries the milliseconds.
   */
  readonly over: number;
}

/**
 * The two `tookMs` of one window, read out of the log it left in the store.
 *
 * The LAST of each, because a log file is named after an activation and a file
 * that somehow holds two is a file whose second one is this run's.
 *
 * The message has to be where the format puts it -- after the level, at the
 * start of what remains -- so that a line merely quoting the sentence inside its
 * own context cannot be read as the line itself.
 */
export function startTimesIn(log: string): { listedMs: number | null, activatedMs: number | null } {
  return { listedMs: lastTookMs(log, LISTED), activatedMs: lastTookMs(log, ACTIVATED) };
}

function lastTookMs(log: string, message: string): number | null {
  let found: number | null = null;
  for (const line of log.split(/\r?\n/u)) {
    const took = tookMsOf(line, message);
    if (took !== null) {
      found = took;
    }
  }
  return found;
}

/**
 * `<iso> <level> <message> <details as JSON>`, which is `FileLog`'s own format.
 *
 * Three fields and not a regular expression over the whole line: the details are
 * JSON and the message is fixed, so the only thing worth parsing is where the
 * two meet.
 */
function tookMsOf(line: string, message: string): number | null {
  const parts = line.split(' ');
  const head = parts.slice(0, 2).join(' ');
  const rest = line.slice(head.length + 1);
  if (!rest.startsWith(`${message} `)) {
    return null;
  }
  let details: unknown;
  try {
    details = JSON.parse(rest.slice(message.length + 1));
  } catch {
    return null;
  }
  const took = (details as { readonly tookMs?: unknown }).tookMs;
  return typeof took === 'number' && Number.isFinite(took) ? took : null;
}

export function judgeTheStart(
  readings: readonly StartReading[],
  budget: StartBudget
): StartVerdict {
  const silent = readings.filter((one) => one.listedMs === null && one.activatedMs === null);
  const spoke = readings.filter((one) => one.listedMs !== null || one.activatedMs !== null);
  if (spoke.length === 0) {
    return {
      answer: 'unmeasured',
      because:
        readings.length === 0
          ? 'no sitting of this run left a log in the store, so nothing was timed'
          : `no sitting of this run said how long it took (${String(readings.length)} of them)`,
      over: 0,
    };
  }

  const over: string[] = [];
  for (const one of spoke) {
    if (one.listedMs !== null && one.listedMs > budget.listedMs) {
      over.push(`sitting ${String(one.sitting)} took ${String(one.listedMs)} ms to put the list on screen`);
    }
    if (one.activatedMs !== null && one.activatedMs > budget.activatedMs) {
      over.push(`sitting ${String(one.sitting)} took ${String(one.activatedMs)} ms to activate`);
    }
  }

  const all = spoke
    .map((one) => `${String(one.sitting)} -> ${say(one.listedMs)}/${say(one.activatedMs)} ms`)
    .join(', ');
  const unheard =
    silent.length === 0
      ? ''
      : ` (nothing was timed in sitting${silent.length === 1 ? '' : 's'} ${silent.map((one) => String(one.sitting)).join(', ')})`;

  return over.length === 0
    ? {
      answer: 'green',
      because: `list/activation, inside the ${String(budget.listedMs)}/${String(budget.activatedMs)} ms budget: ${all}${unheard}`,
      over: 0,
    }
    : {
      answer: 'red',
      because: `over the ${String(budget.listedMs)}/${String(budget.activatedMs)} ms budget: ${over.join('; ')} (all of them: ${all})${unheard}`,
      over: over.length,
    };
}

function say(ms: number | null): string {
  return ms === null ? '-' : String(ms);
}
