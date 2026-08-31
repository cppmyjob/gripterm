import {
  readPreviousRun,
  runsThatLeftNoGoodbye,
} from '../../packages/core/src/domain/services/runs-without-a-goodbye';
import { makeOwnerIdentity } from '../helpers/domain-fixtures';
import type { OwnerSurvey } from '../../packages/core/src/domain/ports/owner-presence';

/**
 * What a presence file left behind establishes about the run that wrote it --
 * and, far more importantly, what it does NOT.
 *
 * **Why this exists.** О1 was first walked under our own engine on 2026-08-31,
 * and it went red because the acceptance KILLS our extension host. That is a
 * blow, not an observation: how often the host actually ends without a goodbye
 * on a person's own machine is known by nobody, the owner's editor logs are out
 * of bounds, and the decision that waits on the number -- a pty host of its own,
 * several days of work -- is not one to take on a guess. So the product counts
 * it itself.
 *
 * **The one thing this instrument may never say.** The third reading below is
 * NOT "the extension host fell over". A person who ends the editor from the task
 * manager lands in exactly the same case, and so does every other hard end;
 * nothing here can tell them apart, and naming any of them would be reporting a
 * conclusion where there is only a reading. What is established is the whole of
 * what the two comparisons support: the previous run left no goodbye, and the
 * machine did not restart between then and now.
 *
 * Three cases and three assertions, and the third has to differ from the second
 * or the instrument does not divide anything: a machine that restarted leaves
 * exactly the same orphaned file (`deactivate` is not called on a restart --
 * microsoft/vscode#70665), and counting those would count every reboot.
 */

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const HOUR_SECONDS = 3600;
const HOUR_MS = 3_600_000;

describe('what the presence file of a previous run establishes', () => {
  it('reads no file at all as a run that said goodbye', () => {
    // `deactivate` removes the file, and it is the only thing that does. Its
    // absence is the one case in this table that is a positive fact.
    expect(readPreviousRun({ heartbeatAtMs: null, nowMs: NOW, uptimeSeconds: HOUR_SECONDS }))
      .toBe('said-goodbye');
  });

  it('reads a file whose last beat predates the boot as a machine that restarted', () => {
    // `deactivate` is not called when the machine restarts, so an orphaned file
    // is the NORMAL outcome of a reboot. Counting it would count reboots.
    expect(readPreviousRun({ heartbeatAtMs: NOW - HOUR_MS - 1, nowMs: NOW, uptimeSeconds: HOUR_SECONDS }))
      .toBe('the-machine-restarted');
  });

  it('reads a file whose last beat is younger than the boot as a run that left no goodbye', () => {
    // The same file as the case above, one millisecond the other side of the
    // boot -- which is the whole of what divides them.
    expect(readPreviousRun({ heartbeatAtMs: NOW - HOUR_MS + 1, nowMs: NOW, uptimeSeconds: HOUR_SECONDS }))
      .toBe('no-goodbye-and-no-restart');
  });

  it('reads the boot moment itself as this life, the way every other rule on this machine does', () => {
    // The tie falls on the side of `precedesBoot`, which is where every other
    // reader of the boot rule puts it. One rule, one boundary.
    expect(readPreviousRun({ heartbeatAtMs: NOW - HOUR_MS, nowMs: NOW, uptimeSeconds: HOUR_SECONDS }))
      .toBe('no-goodbye-and-no-restart');
  });
});

describe('which of the windows in the store this start came up after', () => {
  it('counts a dead window whose last beat is younger than the boot', () => {
    expect(
      runsThatLeftNoGoodbye({
        survey: [dead('other', NOW - HOUR_MS + 1)],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([{ ownerId: 'other', heartbeatAtMs: NOW - HOUR_MS + 1 }]);
  });

  it('leaves out the same window when its last beat predates the boot', () => {
    expect(
      runsThatLeftNoGoodbye({
        survey: [dead('other', NOW - HOUR_MS - 1)],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([]);
  });

  it('leaves out this window`s own file, which it has just written', () => {
    // Announced before anything reads `owners/`, so our own file is always
    // there and is never a previous run.
    expect(
      runsThatLeftNoGoodbye({
        survey: [row('this-one', 'live', NOW)],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([]);
  });

  it('leaves out a window that is still there', () => {
    // A second window open right now is not a previous run at all, whatever its
    // heartbeat says about the boot.
    expect(
      runsThatLeftNoGoodbye({
        survey: [row('other', 'live', NOW - 1000)],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([]);
  });

  it('leaves out a window nothing could establish anything about', () => {
    // `unknown` is a window that is there and not talking -- asleep, hung, or on
    // a machine that stalled. Counting it would be this instrument guessing, and
    // the direction it errs in is the honest one: it under-counts.
    expect(
      runsThatLeftNoGoodbye({
        survey: [row('other', 'unknown', NOW - 90_000)],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([]);
  });

  it('leaves out a file that did not decode, which has no beat to compare', () => {
    expect(
      runsThatLeftNoGoodbye({
        survey: [{ name: 'other', fileName: 'other.json', identity: null, heartbeatAt: null, liveness: 'unknown' }],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      })
    ).toStrictEqual([]);
  });

  it('counts each window in the store separately', () => {
    expect(
      runsThatLeftNoGoodbye({
        survey: [
          dead('first', NOW - 60_000),
          row('this-one', 'live', NOW),
          dead('second', NOW - HOUR_MS - 1),
          dead('third', NOW - 30_000),
        ],
        self: 'this-one',
        nowMs: NOW,
        uptimeSeconds: HOUR_SECONDS,
      }).map((one) => one.ownerId)
    ).toStrictEqual(['first', 'third']);
  });
});

function row(name: string, liveness: OwnerSurvey['liveness'], heartbeatAtMs: number): OwnerSurvey {
  return {
    name,
    fileName: `${name}.json`,
    identity: makeOwnerIdentity(name),
    heartbeatAt: new Date(heartbeatAtMs),
    liveness,
  };
}

/** A window the store has established is gone -- the only kind that can be a previous run. */
function dead(name: string, heartbeatAtMs: number): OwnerSurvey {
  return row(name, 'dead', heartbeatAtMs);
}
