import { precedesBoot } from './boot-window';
import type { OwnerSurvey } from '../ports/owner-presence';

/**
 * What the presence file of a previous run establishes, and nothing more.
 *
 * Three readings, because there are three cases the two comparisons available
 * can tell apart, and the middle one is what makes the instrument worth having:
 * `deactivate` is NOT called when the machine restarts
 * (microsoft/vscode#70665), so an orphaned file is the ordinary outcome of a
 * reboot, and a counter that did not divide those out would be counting reboots.
 *
 * **`no-goodbye-and-no-restart` is a READING, never a diagnosis.** It says what
 * its name says and stops there. A person who ends the editor from the task
 * manager produces exactly this file; so does a machine losing power with the
 * uptime clock landing the wrong side of the comparison; so does anything else
 * that ends a run hard. Nothing here can tell them apart, and giving the case a
 * name that picked one of them would be this build reporting a conclusion where
 * it has only an observation.
 */
export type PreviousRunReading =
  /** No file: `retire()` took it away, which is the one thing that ever does. */
  | 'said-goodbye'
  /** A file whose last beat is older than this boot -- so a restart orphaned it. */
  | 'the-machine-restarted'
  /** A file whose last beat is younger than this boot. Counted. */
  | 'no-goodbye-and-no-restart';

export interface PreviousRunEvidence {
  /** The last beat in the file the previous run left, or `null` when it left none. */
  readonly heartbeatAtMs: number | null;
  /** Sampled by the caller, so that both terms of the boot rule come from one instant. */
  readonly nowMs: number;
  /** `os.uptime()` at the caller -- see `precedesBoot` for what it is trusted for. */
  readonly uptimeSeconds: number;
}

/**
 * The whole of the rule, as one function of three readings.
 *
 * It stands on `precedesBoot` rather than repeating its arithmetic, so that the
 * boundary this draws is the same boundary owner liveness and the restore
 * planner draw. A second copy of that comparison would be a second answer to
 * "was the machine up then", and the two would drift.
 */
export function readPreviousRun(evidence: PreviousRunEvidence): PreviousRunReading {
  const { heartbeatAtMs } = evidence;
  if (heartbeatAtMs === null) {
    return 'said-goodbye';
  }
  return precedesBoot(heartbeatAtMs, evidence.nowMs, evidence.uptimeSeconds)
    ? 'the-machine-restarted'
    : 'no-goodbye-and-no-restart';
}

/** One run whose presence file this start found still lying in `owners/`. */
export interface LeftoverRun {
  /** The window the file is named for -- the only handle a record's `ownerId` can be compared against. */
  readonly ownerId: string;
  readonly heartbeatAtMs: number;
}

export interface LeftoverRunInputs {
  /** Every file in `owners/`, live or not, readable or not. */
  readonly survey: readonly OwnerSurvey[];
  /** This window's own id, whose file is always there and is never a previous run. */
  readonly self: string;
  readonly nowMs: number;
  readonly uptimeSeconds: number;
}

/**
 * Which of the files in `owners/` this start came up after.
 *
 * **Every exclusion errs towards counting nothing**, and that is the direction
 * the number is worth having in: it is going to be weighed against several days
 * of work on a pty host of its own, and a count that is too high argues for
 * spending them.
 *
 *   * `live` -- a window open right now is not a previous run at all.
 *   * `unknown` -- a window that is there and not talking: asleep, hung, or on a
 *     machine that stalled. Nothing is established about it, so nothing is
 *     counted for it.
 *   * a file that did not decode -- there is no beat in it to compare, and a
 *     file nobody can read is the one thing this build must never draw a
 *     conclusion from.
 *
 * `dead` is the only verdict left, and it is reached by two rules: a beat older
 * than the boot, or no process at that pid. The first of those is the middle
 * case above and is dropped here; the second is what is counted.
 *
 * A window whose pid has been handed to some LIVING stranger reads `live` or
 * `unknown` and is not counted -- an under-count, in the same direction as the
 * rest.
 */
export function runsThatLeftNoGoodbye(inputs: LeftoverRunInputs): readonly LeftoverRun[] {
  const runs: LeftoverRun[] = [];
  for (const row of inputs.survey) {
    if (row.name === inputs.self || row.liveness !== 'dead' || row.heartbeatAt === null) {
      continue;
    }
    const heartbeatAtMs = row.heartbeatAt.getTime();
    const reading = readPreviousRun({
      heartbeatAtMs,
      nowMs: inputs.nowMs,
      uptimeSeconds: inputs.uptimeSeconds,
    });
    if (reading === 'no-goodbye-and-no-restart') {
      runs.push({ ownerId: row.name, heartbeatAtMs });
    }
  }
  return runs;
}
