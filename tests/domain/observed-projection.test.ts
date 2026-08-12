import {
  ContextWindowSnapshot,
  CostSnapshot,
  ObservedState,
  SessionId,
  TerminalStateMachine,
  projectObserved,
} from '../../packages/core/src/index';
import type {
  HookEventContext,
  ProjectedEvent,
  TerminalEvent,
} from '../../packages/core/src/index';
import { NEXT_SESSION_UUID, SESSION_UUID } from '../helpers/domain-fixtures';

/**
 * A history folded back into the state it left behind.
 *
 * The function is pure and the test says so by having nothing in it but values:
 * no clock, no store, no fake. Every moment comes from the events themselves,
 * which is the property that makes a replay produce the same answer today and
 * next year.
 *
 * What this must NOT become is a second statement of the rules. `observedAfter`
 * is shared with `SessionRegistry` on purpose, and the test that the two agree
 * is `journal-replay.test.ts`, which runs both over one history.
 */

const SESSION = SessionId.fromString(SESSION_UUID);
const OTHER_SESSION = SessionId.fromString(NEXT_SESSION_UUID);

const START = new Date('2026-08-11T12:00:00.000Z');
const MINUTE_MS = 60_000;

const CONTEXT: Omit<HookEventContext, 'sessionId'> = {
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

const machine = new TerminalStateMachine();

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE_MS);
}

function moment(event: TerminalEvent, minutes: number): ProjectedEvent {
  return { event, at: at(minutes) };
}

function launching(): ObservedState {
  return ObservedState.create({
    state: 'launching',
    lastEventAt: START,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

function project(...events: readonly ProjectedEvent[]): ReturnType<typeof projectObserved> {
  return projectObserved({ from: launching(), sessionId: SESSION, events, machine });
}

describe('folding a history back into a state', () => {
  it('answers with what it was given when there is nothing to fold', async () => {
    const projection = project();

    expect(projection.observed).toStrictEqual(launching());
    expect(projection).toMatchObject({ applied: 0, ignored: 0, foreign: 0 });
  });

  it('ends where the last event left the terminal', async () => {
    const projection = project(
      moment({ kind: 'SessionStart', sessionId: SESSION, source: 'startup', ...CONTEXT }, 0),
      moment({ kind: 'UserPromptSubmit', sessionId: SESSION, userInput: 'go on', ...CONTEXT }, 1),
      moment(
        { kind: 'PreToolUse', sessionId: SESSION, toolName: 'Bash', toolUseId: 't1', ...CONTEXT },
        2
      )
    );

    expect(projection.observed.state).toBe('working');
    expect(projection.observed.currentTool).toBe('Bash');
    expect(projection.applied).toBe(3);
  });

  it('stamps each step with the moment the journal recorded, never with now', async () => {
    // The whole point of a replay: the times are the ones that happened. A
    // rebuild that stamped `now` would report a terminal as having spoken a
    // moment ago, and every reconciler downstream reads that field as evidence.
    const projection = project(
      moment({ kind: 'Stop', sessionId: SESSION, lastAssistantMessage: 'done', ...CONTEXT }, 7)
    );

    expect(projection.observed.lastEventAt).toStrictEqual(at(7));
  });

  it('keeps the last thing the assistant said, and forgets it on a new conversation', async () => {
    const projection = project(
      moment({ kind: 'Stop', sessionId: SESSION, lastAssistantMessage: 'done', ...CONTEXT }, 1),
      moment(
        { kind: 'SessionStart', sessionId: OTHER_SESSION, source: 'clear', ...CONTEXT },
        2
      )
    );

    expect(projection.observed.lastAssistantMessage).toBeNull();
  });

  it('carries through what no hook event produces', async () => {
    // Cost, context window and pid come from the statusline forwarder and the
    // gateway. A fold that reset them on every event would make those channels
    // look broken after a restore.
    const from = ObservedState.create({
      state: 'idle',
      lastEventAt: START,
      currentTool: null,
      lastAssistantMessage: null,
      cost: CostSnapshot.create(0.42, 1000),
      contextWindow: ContextWindowSnapshot.create(37),
      pid: 4242,
    });

    const projection = projectObserved({
      from,
      sessionId: SESSION,
      events: [
        moment({ kind: 'UserPromptSubmit', sessionId: SESSION, userInput: 'x', ...CONTEXT }, 1),
      ],
      machine,
    });

    expect(projection.observed.cost).toStrictEqual(from.cost);
    expect(projection.observed.contextWindow).toStrictEqual(from.contextWindow);
    expect(projection.observed.pid).toBe(4242);
  });
});

describe('a history with more than one conversation in it', () => {
  it('does not apply an event from a conversation the terminal was not having', async () => {
    // §4.6, case 2, met on the replay path: a `SessionEnd` still in flight from
    // the session `/clear` replaced would otherwise kill the session that
    // replaced it -- an hour later, out of a file.
    const projection = project(
      moment({ kind: 'UserPromptSubmit', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1),
      moment({ kind: 'SessionEnd', sessionId: OTHER_SESSION, reason: 'clear', ...CONTEXT }, 2)
    );

    expect(projection.observed.state).toBe('working');
    expect(projection).toMatchObject({ applied: 1, foreign: 1 });
  });

  it('follows the conversation a SessionStart announces, and applies what comes after it', async () => {
    const projection = project(
      moment({ kind: 'SessionStart', sessionId: OTHER_SESSION, source: 'clear', ...CONTEXT }, 1),
      moment({ kind: 'UserPromptSubmit', sessionId: OTHER_SESSION, userInput: 'go', ...CONTEXT }, 2)
    );

    expect(projection.observed.state).toBe('working');
    expect(projection).toMatchObject({ applied: 2, foreign: 0 });
  });
});

describe('a history the state machine refuses', () => {
  it('counts what it dropped and does not move the clock for it', async () => {
    // A hook that arrives after a witnessed end is dropped, and dropping it must
    // leave `lastEventAt` alone: a record whose clock moved for events it
    // refused makes "nothing has happened here for ten minutes" unreadable.
    const projection = project(
      moment({ kind: 'SessionEnd', sessionId: SESSION, reason: 'logout', ...CONTEXT }, 1),
      moment({ kind: 'PostToolUse', sessionId: SESSION, toolName: 'Bash', toolUseId: 't', ...CONTEXT }, 5)
    );

    expect(projection.observed.state).toBe('ended');
    expect(projection.observed.lastEventAt).toStrictEqual(at(1));
    expect(projection).toMatchObject({ applied: 1, ignored: 1 });
  });
});
