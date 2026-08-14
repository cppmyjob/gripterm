import { ValidationError, shellQuietVerdict } from '../../packages/core/src/index';
import type { ShellQuietPolicy, ShellQuietState } from '../../packages/core/src/index';

/**
 * The numbers here are not invented either. They are what a real VS Code
 * answered on 2026-08-14, three runs, when a terminal was created while another
 * extension typed into it from `onDidOpenTerminal`:
 *
 *   the other extension typed at   20, 23, 60 ms after the terminal was made
 *   shell integration announced at 5215, 5514, 5728 ms
 *   the other command STARTED at   +277, +284, +423 ms after that
 *   and ended                      +30, +32, +40 ms later
 *
 * So a line typed straight after creation goes FIRST -- measured, `["ours",
 * "other"]` -- and the whole of this policy is the arithmetic of not doing that.
 */
const POLICY: ShellQuietPolicy = { graceMs: 1500, readyMs: 15000, patienceMs: 30000 };

/** A terminal made at zero, with nothing known about it yet. */
const FRESH: ShellQuietState = {
  createdAt: 0,
  integrationAt: null,
  inFlight: 0,
  lastEndedAt: null,
};

describe('deciding when a launch line may be typed into a fresh shell', () => {
  it('waits while nothing is known, because typing now is what put us first', () => {
    expect(shellQuietVerdict(FRESH, 60, POLICY)).toBe('wait');
  });

  it('waits while the shell has not announced itself, however long that takes', () => {
    expect(shellQuietVerdict(FRESH, 5000, POLICY)).toBe('wait');
  });

  it('gives up waiting for a shell that never announces itself', () => {
    // A shell with no integration -- `cmd.exe`, or a person who turned it off.
    // The line still has to be typed, and the log says which of the two it was.
    expect(shellQuietVerdict(FRESH, 15000, POLICY)).toBe('impatient');
  });

  it('waits while somebody else has a command in flight, however long the quiet before it', () => {
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 1, lastEndedAt: null };

    expect(shellQuietVerdict(state, 5960, POLICY)).toBe('wait');
    // Past the grace, and still waiting: a shell running somebody's command is
    // not a quiet shell, whatever the clock says.
    expect(shellQuietVerdict(state, 7500, POLICY)).toBe('wait');
  });

  it('waits out the grace after their command ended, not merely its end', () => {
    // Counted from the END, not from the announcement: with the grace measured
    // from the announcement this reads as quiet, which is the whole defect.
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 0, lastEndedAt: 6969 };

    expect(shellQuietVerdict(state, 7469, POLICY)).toBe('wait');
    expect(shellQuietVerdict(state, 8469, POLICY)).toBe('quiet');
  });

  it('types once the shell has been quiet for the grace', () => {
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 0, lastEndedAt: 5969 };

    expect(shellQuietVerdict(state, 7469, POLICY)).toBe('quiet');
  });

  it('counts the grace from the announcement when nobody has run anything', () => {
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 0, lastEndedAt: null };

    expect(shellQuietVerdict(state, 7014, POLICY)).toBe('quiet');
    expect(shellQuietVerdict(state, 7013, POLICY)).toBe('wait');
  });

  it('counts the grace from whichever came last, the announcement or their command', () => {
    /*
     * Measured: their command STARTS after the announcement, so in a real host
     * the announcement is never the later of the two. This is the other order,
     * and the rule holds there as well rather than by luck: an end reported
     * before the shell announced itself must not shorten the wait, or the launch
     * line goes in while the shell is still coming up -- which is A12, the race
     * this milestone exists to close.
     */
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 0, lastEndedAt: 5000 };

    expect(shellQuietVerdict(state, 6600, POLICY)).toBe('wait');
    expect(shellQuietVerdict(state, 7014, POLICY)).toBe('quiet');
  });

  it('stops waiting for a command that does not end, because typing is safe then', () => {
    /*
     * Measured 2026-08-14: a line typed into a shell that is busy is buffered
     * and runs after -- `["other", "ours"]`, both alive and in order. So an
     * upper bound on our patience costs the ordering nothing, and the agent of
     * somebody who left a build running still starts.
     */
    const state: ShellQuietState = { ...FRESH, integrationAt: 5514, inFlight: 1, lastEndedAt: null };

    expect(shellQuietVerdict(state, 30000, POLICY)).toBe('impatient');
    expect(shellQuietVerdict(state, 29999, POLICY)).toBe('wait');
  });

  it('refuses a policy with no grace at all, which is the defect it exists to stop', () => {
    expect(() => shellQuietVerdict(FRESH, 0, { ...POLICY, graceMs: 0 })).toThrow(ValidationError);
  });

  it('refuses a policy that gives up before it has waited', () => {
    // Patience below the sum is a policy that reads "give up" before it can ever
    // read "quiet" -- an ordering promise that cannot be kept.
    expect(() => shellQuietVerdict(FRESH, 0, { ...POLICY, patienceMs: 16499 })).toThrow(ValidationError);
  });

  it('refuses a policy that never waits for the shell', () => {
    expect(() => shellQuietVerdict(FRESH, 0, { ...POLICY, readyMs: 0 })).toThrow(ValidationError);
  });
});
