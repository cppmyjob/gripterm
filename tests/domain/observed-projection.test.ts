import {
  ContextWindowSnapshot,
  CostSnapshot,
  ObservedState,
  SessionId,
  TerminalStateMachine,
  observedAtStart,
  projectObserved,
} from '../../packages/core/src/index';
import type {
  AgentEventContext,
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

const CONTEXT: Omit<AgentEventContext, 'sessionId'> = {
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

/*
 * The customer's fifth complaint, replayed from the measurement that explains
 * it (2026-08-21, a real CLI with all thirty-one hooks registered):
 *
 *   17.77  SubagentStarted a0f2   19.22  SubagentStarted a1e4
 *   25.69  TurnFinished                 <- the main agent, done launching them
 *   85.71  AgentNotified idle_prompt
 *  107.42  SubagentFinished  a1e4  109.18  SubagentFinished a0f2
 *
 * Read as this build read it before that day, the terminal was idle from 25.69
 * -- a green tick over eighty seconds of work.
 */
describe('a turn whose subagents outlive it', () => {
  const ONE = 'a0f2051a530b4c7a2';
  const TWO = 'a1e499b3f0c990cc8';

  function subagent(kind: 'SubagentStarted' | 'SubagentFinished', agentId: string, minute: number): ProjectedEvent {
    return moment({ kind, sessionId: SESSION, agentId, agentType: 'general-purpose', ...CONTEXT }, minute);
  }

  it('is working while its subagents are, and idle only when the last of them is done', () => {
    const prompt = moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1);
    const started = [subagent('SubagentStarted', ONE, 2), subagent('SubagentStarted', TWO, 3)];
    const stopped = moment({ kind: 'TurnFinished', sessionId: SESSION, lastAssistantMessage: 'they are running', ...CONTEXT }, 4);
    const idlePrompt = moment(
      { kind: 'AgentNotified', sessionId: SESSION, notificationType: 'idle_prompt', message: 'waiting', ...CONTEXT },
      5
    );

    expect(project(prompt, ...started, stopped).observed.state).toBe('working');
    expect(project(prompt, ...started, stopped, idlePrompt).observed.state).toBe('working');
    expect(
      project(prompt, ...started, stopped, idlePrompt, subagent('SubagentFinished', TWO, 6)).observed.state
    ).toBe('working');
    expect(
      project(
        prompt,
        ...started,
        stopped,
        idlePrompt,
        subagent('SubagentFinished', TWO, 6),
        subagent('SubagentFinished', ONE, 7)
      ).observed.state
    ).toBe('idle');
  });

  it('keeps the names of what is running, and drops them as they finish', () => {
    const running = project(
      moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1),
      subagent('SubagentStarted', ONE, 2),
      subagent('SubagentStarted', TWO, 3)
    ).observed.running;

    expect([...running]).toStrictEqual(['main', ONE, TWO]);
  });

  it('ignores a subagent finishing that nobody saw start', () => {
    // Measured in the same run: five `SubagentFinished`s named ids that had never
    // been started. A count would have reached zero with the work still going.
    const projection = project(
      moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1),
      subagent('SubagentStarted', ONE, 2),
      subagent('SubagentFinished', 'a463b3e885b0d0335', 3),
      moment({ kind: 'TurnFinished', sessionId: SESSION, lastAssistantMessage: null, ...CONTEXT }, 4)
    );

    expect([...projection.observed.running]).toStrictEqual([ONE]);
    expect(projection.observed.state).toBe('working');
  });

  it('forgets everything that was running when the conversation starts again', () => {
    const projection = project(
      moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1),
      subagent('SubagentStarted', ONE, 2),
      moment({ kind: 'ConversationStarted', sessionId: SESSION, source: 'clear', ...CONTEXT }, 3)
    );

    expect([...projection.observed.running]).toStrictEqual([]);
  });

  it('carries nothing running into a start of its own', () => {
    // A record being launched or resumed: whoever was running was running in a
    // process that is gone.
    const before = ObservedState.create({
      state: 'working',
      lastEventAt: START,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
      running: ['main', ONE],
    });

    expect([...observedAtStart(before, at(1)).running]).toStrictEqual([]);
  });
});

describe('folding a history back into a state', () => {
  it('answers with what it was given when there is nothing to fold', async () => {
    const projection = project();

    expect(projection.observed).toStrictEqual(launching());
    expect(projection).toMatchObject({ applied: 0, ignored: 0, foreign: 0 });
  });

  it('ends where the last event left the terminal', async () => {
    const projection = project(
      moment({ kind: 'ConversationStarted', sessionId: SESSION, source: 'startup', ...CONTEXT }, 0),
      moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go on', ...CONTEXT }, 1),
      moment(
        { kind: 'ToolStarted', sessionId: SESSION, toolName: 'Bash', toolUseId: 't1', ...CONTEXT },
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
      moment({ kind: 'TurnFinished', sessionId: SESSION, lastAssistantMessage: 'done', ...CONTEXT }, 7)
    );

    expect(projection.observed.lastEventAt).toStrictEqual(at(7));
  });

  it('keeps the last thing the assistant said, and forgets it on a new conversation', async () => {
    const projection = project(
      moment({ kind: 'TurnFinished', sessionId: SESSION, lastAssistantMessage: 'done', ...CONTEXT }, 1),
      moment(
        { kind: 'ConversationStarted', sessionId: OTHER_SESSION, source: 'clear', ...CONTEXT },
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
        moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'x', ...CONTEXT }, 1),
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
    // §4.6, case 2, met on the replay path: a `ConversationEnded` still in flight from
    // the session `/clear` replaced would otherwise kill the session that
    // replaced it -- an hour later, out of a file.
    const projection = project(
      moment({ kind: 'PromptSubmitted', sessionId: SESSION, userInput: 'go', ...CONTEXT }, 1),
      moment({ kind: 'ConversationEnded', sessionId: OTHER_SESSION, reason: 'clear', ...CONTEXT }, 2)
    );

    expect(projection.observed.state).toBe('working');
    expect(projection).toMatchObject({ applied: 1, foreign: 1 });
  });

  it('follows the conversation a ConversationStarted announces, and applies what comes after it', async () => {
    const projection = project(
      moment({ kind: 'ConversationStarted', sessionId: OTHER_SESSION, source: 'clear', ...CONTEXT }, 1),
      moment({ kind: 'PromptSubmitted', sessionId: OTHER_SESSION, userInput: 'go', ...CONTEXT }, 2)
    );

    expect(projection.observed.state).toBe('working');
    expect(projection).toMatchObject({ applied: 2, foreign: 0 });
  });
});

describe('the snapshot of a record whose process is being started', () => {
  /** A record as its window left it: mid-turn, with a tool running and a pid. */
  function working(): ObservedState {
    return ObservedState.create({
      state: 'working',
      lastEventAt: at(1),
      currentTool: 'Bash',
      lastAssistantMessage: 'I will read the file first',
      cost: CostSnapshot.create(0.42, 1000),
      contextWindow: ContextWindowSnapshot.create(12.5),
      pid: 4242,
    });
  }

  it('says launching, whatever the record was doing when its window died', async () => {
    // Three rules downstream ask for exactly this state and do nothing without
    // it: a non-zero exit read as a FAILED restore (§4.3), the resume timeout,
    // and the silence watch.
    expect(observedAtStart(working(), at(9)).state).toBe('launching');
  });

  it('stamps the moment the start was asked for', async () => {
    expect(observedAtStart(working(), at(9)).lastEventAt).toStrictEqual(at(9));
  });

  it('forgets the tool, because the process running it is gone', async () => {
    expect(observedAtStart(working(), at(9)).currentTool).toBeNull();
  });

  it('forgets the pid, because that number belongs to a previous life', async () => {
    // Windows hands pids out again aggressively, so a kept pid is a question
    // asked about a stranger -- and the answer authorises or forbids a restore.
    expect(observedAtStart(working(), at(9)).pid).toBeNull();
  });

  it('keeps what is still true of the conversation', async () => {
    // It is the SAME conversation: what it last said, what it has cost and how
    // full its context is do not stop being true because the process restarted.
    const started = observedAtStart(working(), at(9));

    expect(started.lastAssistantMessage).toBe('I will read the file first');
    expect(started.cost).toStrictEqual(working().cost);
    expect(started.contextWindow).toStrictEqual(working().contextWindow);
  });

  it('changes nothing about a terminal that is being launched for the first time', async () => {
    // The launch path builds exactly this state already, so passing through
    // must be a no-op -- otherwise one of the two paths is describing something
    // that did not happen.
    expect(observedAtStart(launching(), START)).toStrictEqual(launching());
  });
});

describe('a history the state machine refuses', () => {
  it('counts what it dropped and does not move the clock for it', async () => {
    // A hook that arrives after a witnessed end is dropped, and dropping it must
    // leave `lastEventAt` alone: a record whose clock moved for events it
    // refused makes "nothing has happened here for ten minutes" unreadable.
    // The history begins with the beginning on purpose. Since A45 a `ConversationEnded`
    // is refused while the record is still `launching` -- the CLI shutting down
    // says nothing about whether the start got going -- so a witnessed end is
    // now reached the way a real conversation reaches it: it started first.
    const projection = project(
      moment({ kind: 'ConversationStarted', sessionId: SESSION, source: 'startup', ...CONTEXT }, 0),
      moment({ kind: 'ConversationEnded', sessionId: SESSION, reason: 'logout', ...CONTEXT }, 1),
      moment({ kind: 'ToolFinished', sessionId: SESSION, toolName: 'Bash', toolUseId: 't', ...CONTEXT }, 5)
    );

    expect(projection.observed.state).toBe('ended');
    expect(projection.observed.lastEventAt).toStrictEqual(at(1));
    expect(projection).toMatchObject({ applied: 2, ignored: 1 });
  });
});
