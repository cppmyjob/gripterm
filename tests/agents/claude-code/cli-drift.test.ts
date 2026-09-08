import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_DRIFT,
  SUPPORTED_CLI_VERSION,
} from '../../../packages/core/src/domain/agents/claude-code/cli-version';
import type { CliDrift } from '../../../packages/core/src/domain/agents/claude-code/cli-version';

/**
 * TWO NUMBERS ABOUT THE SAME CLI, AND ONLY ONE OF THEM WAS EVER WATCHED.
 *
 * `SUPPORTED_CLI_VERSION` is 2.1.225. The build stamp on the newest capture this
 * repository has taken from a real CLI --
 * `tests/agents/fixtures/roster-scene-2026-09-08.json` -- is 2.1.260. Between
 * 2026-08-09, when the pin was measured, and 2026-09-08 they drifted thirty-five
 * patch builds apart and nothing went red about it: the stamp has a guard
 * (`tests/integration/agent-listing.test.ts` compares it with the installed CLI)
 * and the pin has none that a run can reach.
 *
 * **What this file does NOT hold, and it is the point of it.** It does not hold
 * the two numbers equal. They are different kinds of claim: the pin is frozen on
 * purpose and the stamp must track the machine, so equality is not an invariant,
 * and forcing it would mean either raising the pin -- which the owner refused on
 * 2026-09-08 -- or recapturing the scene against a build nobody can install any
 * more. What it holds instead is that THE GAP IS WRITTEN DOWN: `CLI_DRIFT`,
 * beside the pin it explains, naming both numbers, what was re-measured against
 * the newer build, what was not, and a day on which this record stops being
 * believed.
 *
 * The equality branch is kept all the same, because it is the branch that
 * retires the record: raise the pin to the newest build met and the record is
 * not merely allowed to go, it is required to.
 *
 * **The clock is the real one.** `expires` is checked against today, so the day
 * it passes the unit run goes red -- and the unit run is in `gate:fast`, which
 * is what `pre-push` runs. The same rule is exercised below against a fixed date
 * too, so the expiry is demonstrably able to fire rather than merely believed to
 * be.
 */

const SCENE_NAME = 'tests/agents/fixtures/roster-scene-2026-09-08.json';

/** The newest build this repository has met, read out of the capture it was met in. */
const SCENE = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'roster-scene-2026-09-08.json'), 'utf8')
) as { readonly build: string };

const A_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function days(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Every reason to refuse this record, or none.
 *
 * A list rather than a throw: a record that is wrong in three ways should say so
 * once, and whoever is about to move `expires` should see everything else that
 * the move does not fix.
 */
function refusals(record: CliDrift, pinned: string, newest: string, today: string): readonly string[] {
  const said: string[] = [];

  if (pinned === newest) {
    said.push(
      `the pin and ${SCENE_NAME} both say ${pinned}, so there is no drift left to record: ` +
        'delete CLI_DRIFT and this suite with it'
    );
    return said;
  }

  if (record.pinned !== pinned) {
    said.push(
      `CLI_DRIFT says the pin is ${record.pinned} and SUPPORTED_CLI_VERSION is ${pinned}. ` +
        'The record is about a pin this build no longer carries -- rewrite it against the one it does'
    );
  }
  if (record.newest !== newest) {
    said.push(
      `CLI_DRIFT says the newest build met is ${record.newest} and ${SCENE_NAME} was captured from ` +
        `${newest}. Something newer than the record has been met since it was written, so what it ` +
        'says was measured says nothing about the build now in front of us -- rewrite it'
    );
  }
  if (record.newestSeenIn !== SCENE_NAME) {
    said.push(
      `CLI_DRIFT points at ${record.newestSeenIn} for the newest build and this suite reads ` +
        `${SCENE_NAME}. One of the two has moved and the record no longer names its own source`
    );
  }
  if (record.measured.length === 0) {
    said.push(`CLI_DRIFT names nothing that was put to ${newest}, which is not a drift record but a shrug`);
  }
  if (record.notMeasured.length === 0) {
    said.push(
      `CLI_DRIFT claims nothing is left unmeasured against ${newest}. If that were true the pin ` +
        'would be raised instead; an empty list here is the defect this record exists against'
    );
  }
  if (!A_DATE.test(record.metOn) || Number.isNaN(Date.parse(record.metOn))) {
    said.push(`CLI_DRIFT has metOn ${JSON.stringify(record.metOn)}, which is not a day`);
  }
  if (!A_DATE.test(record.expires) || Number.isNaN(Date.parse(record.expires))) {
    said.push(
      `CLI_DRIFT has expires ${JSON.stringify(record.expires)}, which is not a day. A record ` +
        'without one never stops being believed'
    );
    return said;
  }
  if (record.expires <= record.metOn) {
    said.push(
      `CLI_DRIFT expires on ${record.expires}, which is not after the day it was written (${record.metOn})`
    );
  }
  // `${n} days` and not a bare `${n}`: a bare one is satisfied by the "26"
  // inside "2.1.260", which is how this check first went green by accident.
  if (!record.whyThatMany.includes(`${String(days(record.metOn, record.expires))} days`)) {
    said.push(
      `CLI_DRIFT gives itself ${String(days(record.metOn, record.expires))} days and whyThatMany does ` +
        'not name that number. A justification that does not say what it justifies is prose'
    );
  }
  if (today >= record.expires) {
    said.push(
      `CLI_DRIFT expired on ${record.expires} and today is ${today}. The pin is still ${pinned} and ` +
        `the newest build met is ${newest}. Put what has changed to the newer build, rewrite what was ` +
        'and was not measured, and set a new day -- or raise the pin and delete the record'
    );
  }

  return said;
}

/** Today, from the machine's own clock: this is the half nobody can push. */
function todayIs(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('the pin and the newest build this repository has met', () => {
  it('either name the same build, or the drift between them is written down beside the pin', () => {
    expect({
      pin: SUPPORTED_CLI_VERSION,
      newest: SCENE.build,
      refused: refusals(CLI_DRIFT, SUPPORTED_CLI_VERSION, SCENE.build, todayIs()),
    }).toStrictEqual({
      pin: SUPPORTED_CLI_VERSION,
      newest: SCENE.build,
      refused: [],
    });
  });

  it('names both numbers itself, so the record cannot be read without the gap', () => {
    expect([CLI_DRIFT.pinned, CLI_DRIFT.newest]).toStrictEqual([SUPPORTED_CLI_VERSION, SCENE.build]);
    expect(CLI_DRIFT.pinned).not.toBe(CLI_DRIFT.newest);
  });

  it('says what was put to the newer build and what was not', () => {
    expect(CLI_DRIFT.measured.length).toBeGreaterThan(0);
    expect(CLI_DRIFT.notMeasured.length).toBeGreaterThan(0);
    // The three behaviours of 2026-09-08 are named rather than counted: a list
    // that lost one of them and kept its length would pass a count.
    const measured = CLI_DRIFT.measured.join(' ');
    for (const behaviour of ['nameSource', 'listing', '--version']) {
      expect(measured).toContain(behaviour);
    }
  });

  it('carries a decision with a day and a source on it', () => {
    expect(CLI_DRIFT.decidedBy).toContain('2026-09-08');
    expect(CLI_DRIFT.renewals).toBeGreaterThanOrEqual(0);
  });

  /*
   * The positive control. The rule above is asked the same question on a day
   * past the record's own deadline, and it has to refuse -- otherwise the expiry
   * is a string in a file and the first test here is green for ever.
   */
  it('stops working on its own deadline, and that is exercised rather than promised', () => {
    const after = new Date(Date.parse(CLI_DRIFT.expires) + 86_400_000).toISOString().slice(0, 10);

    const refused = refusals(CLI_DRIFT, SUPPORTED_CLI_VERSION, SCENE.build, after);

    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(`expired on ${CLI_DRIFT.expires}`);
    expect(refused[0]).toContain(SUPPORTED_CLI_VERSION);
    expect(refused[0]).toContain(SCENE.build);
  });

  it('is required to go when the drift closes, rather than merely allowed to', () => {
    // The branch the owner's decision keeps out of reach today: raise the pin to
    // the newest build met and the record is refused as surplus.
    expect(refusals(CLI_DRIFT, SCENE.build, SCENE.build, todayIs())).toStrictEqual([
      `the pin and ${SCENE_NAME} both say ${SCENE.build}, so there is no drift left to record: ` +
        'delete CLI_DRIFT and this suite with it',
    ]);
  });

  it('refuses a record whose numbers have gone stale under it', () => {
    const stale: CliDrift = { ...CLI_DRIFT, newest: '2.1.245' };

    expect(refusals(stale, SUPPORTED_CLI_VERSION, SCENE.build, todayIs())).toStrictEqual([
      `CLI_DRIFT says the newest build met is 2.1.245 and ${SCENE_NAME} was captured from ` +
        `${SCENE.build}. Something newer than the record has been met since it was written, so what it ` +
        'says was measured says nothing about the build now in front of us -- rewrite it',
    ]);
  });
});
