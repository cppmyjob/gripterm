import {
  HookEventParser,
  ValidationError,
  isAgentEvent,
  launchExitedNonZero,
  processGone,
  resumeExited,
  resumeTimedOut,
  terminalClosed,
  type TerminalEvent,
} from '../../packages/core/src/index';
import { SESSION_UUID } from '../helpers/domain-fixtures';

describe('the synthetic half of the union', () => {
  it('exists because four states have no hook that produces them', () => {
    // ended, orphaned, degraded and resume_failed follow from what the runner
    // observes. Without them in the union the state machine's exhaustive switch
    // would cover an incomplete alphabet and read as proof of completeness.
    const events: readonly TerminalEvent[] = [
      resumeTimedOut(),
      processGone(21344),
      terminalClosed(),
      launchExitedNonZero(1),
      resumeExited(1),
    ];

    expect(events.map((event) => event.kind)).toStrictEqual([
      'ResumeTimedOut',
      'ProcessGone',
      'TerminalClosed',
      'LaunchExitedNonZero',
      'ResumeExited',
    ]);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it('keeps a launch failure and a resume failure apart', () => {
    // Both sit in `launching` and end in different states -- `ended` with a
    // launch_failed signal against `resume_failed`. One event name would map to
    // two mutually exclusive outcomes with nothing in (state, event) to choose
    // between them, so the producer names the event from its LaunchIntent.
    expect(launchExitedNonZero(1).kind).not.toBe(resumeExited(1).kind);
    expect(launchExitedNonZero(127).exitCode).toBe(127);
    expect(resumeExited(1).exitCode).toBe(1);
  });

  it.each([
    ['fractional', 1.5],
    ['not a number', Number.NaN],
  ])('refuses an exit code that is %s', (_label, exitCode) => {
    expect(() => launchExitedNonZero(exitCode)).toThrow(ValidationError);
    expect(() => resumeExited(exitCode)).toThrow(ValidationError);
  });

  it('refuses a zero for a launch and accepts one for a resume', () => {
    // This pair used to be symmetric, and the asymmetry is the point of the
    // change that broke the symmetry (2026-08-25). A launch that exits 0 is a
    // person typing `/exit` into a terminal they had just opened, so an event
    // named "the launch failed" carrying a zero would be a lie. A RESTORE that
    // exits 0 before its conversation ever announced itself did not bring that
    // conversation back, and the code is not what says so -- the record still
    // being `launching` is, which `TerminalLifecycleService` establishes before
    // it builds the event. It has to accept a zero because it is handed one:
    // measured over 34 live runs, the editor reported `exitStatus.code` as 0
    // once for a `claude` that exits 1.
    expect(() => launchExitedNonZero(0)).toThrow(ValidationError);
    expect(resumeExited(0).exitCode).toBe(0);
  });

  it('accepts a missing pid on ProcessGone, and refuses an impossible one', () => {
    expect(processGone(null).pid).toBeNull();
    expect(() => processGone(0)).toThrow(ValidationError);
    expect(() => processGone(-1)).toThrow(ValidationError);
  });
});

describe('isAgentEvent', () => {
  it('separates the events that carry a session id from the ones that do not', () => {
    const result = new HookEventParser().parse({
      hook_event_name: 'Stop',
      session_id: SESSION_UUID,
    });
    const hookEvent = result.status === 'parsed' ? result.event : null;

    expect(hookEvent).not.toBeNull();
    expect(hookEvent !== null && isAgentEvent(hookEvent)).toBe(true);
    expect(isAgentEvent(terminalClosed())).toBe(false);
    expect(isAgentEvent(processGone(null))).toBe(false);
  });
});
