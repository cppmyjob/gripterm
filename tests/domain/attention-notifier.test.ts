import {
  ATTENTION_SIGNALS,
  AttentionNotifier,
  DEFAULT_TOAST_SIGNALS,
  FOCUS_TERMINAL_COMMAND,
  HookEventParser,
  ObservedState,
  SHOW_LOGS_COMMAND,
  SHOW_RECORD_COMMAND,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  isAttentionSignal,
  launchExitedNonZero,
  resumeExited,
  terminalClosed,
  type AttentionPresenter,
  type AttentionRequest,
  type AgentEventContext,
  type PersistedTerminalState,
} from '../../packages/core/src/index';
import { OBSERVED_AT, SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';

/**
 * Every case here is driven through the REGISTRY and the real state machine,
 * never by handing the notifier a transition. That is the point the plan makes
 * about the `waiting_permission → working → waiting_permission` pair: without
 * the absolute `ToolFinished → working` edge (§4.3), a hand-fed test is green on
 * a mock and false on the system.
 *
 * A toast is the one thing this extension does that a person cannot ignore, so
 * the tests are mostly about NOT showing one.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const OTHER_TERMINAL = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
const SESSION = SessionId.fromString(SESSION_UUID);

const CONTEXT: Omit<AgentEventContext, 'sessionId'> = {
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

class RecordingPresenter implements AttentionPresenter {
  public readonly shown: AttentionRequest[] = [];

  public present(request: AttentionRequest): void {
    this.shown.push(request);
  }
}

interface Stand {
  readonly registry: SessionRegistry;
  readonly presenter: RecordingPresenter;
  readonly notifier: AttentionNotifier;
}

function stand(state: PersistedTerminalState = 'idle', signals?: readonly string[]): Stand {
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(new Date('2026-08-11T12:00:00.000Z')),
    logger: new RecordingLogger(),
  });
  registry.register(
    makeEntry({
      observed: ObservedState.create({
        state,
        lastEventAt: OBSERVED_AT,
        currentTool: null,
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      }),
    })
  );
  const presenter = new RecordingPresenter();
  const notifier = new AttentionNotifier({
    registry,
    presenter,
    ...(signals === undefined ? {} : { signals: signals as never }),
  });
  return { registry, presenter, notifier };
}

function permissionRequest(): Parameters<SessionRegistry['ingest']>[1] {
  return { kind: 'PermissionRequested', sessionId: SESSION, toolName: 'Bash', permissionLevel: 'ask', ...CONTEXT };
}

function postToolUse(): Parameters<SessionRegistry['ingest']>[1] {
  return { kind: 'ToolFinished', sessionId: SESSION, toolName: 'Bash', toolUseId: 'tu-1', ...CONTEXT };
}

function stop(): Parameters<SessionRegistry['ingest']>[1] {
  return { kind: 'TurnFinished', sessionId: SESSION, lastAssistantMessage: null, ...CONTEXT };
}

describe('AttentionNotifier interrupts on entering a state, and not otherwise', () => {
  it('says nothing when a turn simply finishes', () => {
    const { registry, presenter } = stand('working');

    registry.ingest(TERMINAL, stop());

    expect(presenter.shown).toHaveLength(0);
  });

  it('shows one toast per ENTRY into a blocking state', () => {
    // The pair comes from the machine: `ToolFinished` is an absolute edge to
    // `working`, which is the only way back out of `waiting_permission`.
    const { registry, presenter } = stand('idle');

    registry.ingest(TERMINAL, permissionRequest());
    registry.ingest(TERMINAL, postToolUse());
    registry.ingest(TERMINAL, permissionRequest());

    expect(presenter.shown).toHaveLength(2);
  });

  it('shows one toast for two identical events in a row', () => {
    // The second is `stayed`, not `moved`. The de-duplication the plan asks for
    // is the state machine's; a Map here would re-derive it less reliably.
    const { registry, presenter } = stand('idle');

    registry.ingest(TERMINAL, permissionRequest());
    registry.ingest(TERMINAL, permissionRequest());

    expect(presenter.shown).toHaveLength(1);
  });

  it('says nothing when a person closes their own terminal', () => {
    // `ended` is not in the default set precisely because a toast on the user's
    // own deliberate action is noise.
    const { registry, presenter } = stand('idle');

    registry.ingest(TERMINAL, terminalClosed());

    expect(presenter.shown).toHaveLength(0);
  });

  it('shows exactly one toast for a launch that exited non-zero', () => {
    const { registry, presenter } = stand('launching');

    registry.ingest(TERMINAL, launchExitedNonZero(1));

    expect(presenter.shown).toHaveLength(1);
    expect(presenter.shown[0]?.signal).toBe('launch_failed');
  });

  it('says nothing about a terminal this window does not hold', () => {
    const { registry, presenter } = stand('idle');

    registry.ingest(OTHER_TERMINAL, permissionRequest());

    expect(presenter.shown).toHaveLength(0);
  });

  it('says nothing when an entry is merely registered', () => {
    const { presenter } = stand('waiting_permission');

    expect(presenter.shown).toHaveLength(0);
  });

  it('says nothing after it has been disposed', () => {
    const { registry, presenter, notifier } = stand('idle');

    notifier.dispose();
    registry.ingest(TERMINAL, permissionRequest());

    expect(presenter.shown).toHaveLength(0);
  });

  it('follows the configured set of signals', () => {
    const { registry, presenter } = stand('working', ['idle']);

    registry.ingest(TERMINAL, stop());

    expect(presenter.shown).toHaveLength(1);
    expect(presenter.shown[0]?.signal).toBe('idle');
  });
});

describe('AttentionNotifier offers a button that does something', () => {
  it('offers the terminal while there is one', () => {
    const { registry, presenter } = stand('idle');

    registry.ingest(TERMINAL, permissionRequest());

    expect(presenter.shown[0]?.actions).toStrictEqual([
      { title: 'Show terminal', command: FOCUS_TERMINAL_COMMAND, arguments: [TERMINAL_UUID] },
    ]);
  });

  it('offers the log when the terminal is already gone', () => {
    // By the time `launch_failed` exists the terminal has been destroyed --
    // the signal is born of its closing -- so "jump to your terminal" would be
    // a button that does nothing. Nothing here can even name the terminal
    // command: it is not in the request.
    const { registry, presenter } = stand('launching');

    registry.ingest(TERMINAL, launchExitedNonZero(127));

    expect(presenter.shown[0]?.actions).toStrictEqual([
      { title: 'Open logs', command: SHOW_LOGS_COMMAND, arguments: [] },
    ]);
    expect(JSON.stringify(presenter.shown)).not.toContain(FOCUS_TERMINAL_COMMAND);
  });

  it('offers the record when a restore failed', () => {
    // The terminal is gone by the time this signal exists, exactly as with
    // `launch_failed`. What is different is where the answer is: a failed
    // LAUNCH leaves nothing but a log line, while a failed RESTORE leaves a
    // record with its name, its task and its notes intact -- and the offer to
    // start over sits on that record (M2.13).
    const { registry, presenter } = stand('launching');

    registry.ingest(TERMINAL, resumeExited(1));

    expect(presenter.shown[0]?.signal).toBe('resume_failed');
    expect(presenter.shown[0]?.actions).toStrictEqual([
      { title: 'Show record', command: SHOW_RECORD_COMMAND, arguments: [TERMINAL_UUID] },
    ]);
  });

  it('names the terminal the way the person named it', () => {
    const { registry, presenter } = stand('idle');

    registry.ingest(TERMINAL, permissionRequest());

    expect(presenter.shown[0]?.message).toBe('auth-refactor is waiting for permission');
  });
});

describe('the signals a person may configure', () => {
  it('interrupts a person for a restore that failed, by default', () => {
    // Without this a failed restore is silent, and silence is the original
    // complaint -- "a restart loses touch with my conversations" -- only
    // quieter. It joins with M2, which is the milestone at which a restore can
    // fail at all.
    expect([...DEFAULT_TOAST_SIGNALS].sort()).toStrictEqual(
      ['launch_failed', 'resume_failed', 'waiting_permission'].sort()
    );
  });

  it('lists exactly the ones the notifier has words for', () => {
    // Derived from the wording table rather than written out twice, so this
    // asserts the derivation rather than a copy of the list.
    expect([...ATTENTION_SIGNALS].sort()).toStrictEqual(
      [
        'degraded',
        'ended',
        'idle',
        'launch_failed',
        'launching',
        'orphaned',
        'resume_failed',
        'turn_failed',
        'waiting_input',
        'waiting_permission',
        'working',
      ].sort()
    );
  });

  it('recognises a signal, and refuses anything else', () => {
    // The consumer is the settings reader: a person can type anything, and a
    // state we do not know must be reported rather than dropped into a set that
    // then silently never matches.
    expect(isAttentionSignal('waiting_permission')).toBe(true);
    expect(isAttentionSignal('launch_failed')).toBe(true);
    expect(isAttentionSignal('detached')).toBe(false);
    expect(isAttentionSignal('')).toBe(false);
    expect(isAttentionSignal('WAITING_PERMISSION')).toBe(false);
  });

  it('does not include detached, which is drawn and never reached', () => {
    // `detached` is laid over the state by the presenter and never produced by
    // the machine, so a notification could not fire on it however it were
    // configured.
    expect(ATTENTION_SIGNALS).not.toContain('detached');
  });
});

/**
 * Other windows' records arrive here wholesale (M2.5), and none of them is a
 * reason to interrupt anybody. The rule is held by the compiler -- a projection
 * change carries no entry to notify about -- and by this test, which is what
 * would notice if somebody gave it one.
 */
describe('AttentionNotifier says nothing about other windows', () => {
  it('stays quiet when the base brings in a terminal waiting for permission', () => {
    const { registry, presenter } = stand();

    registry.replaceForeign([
      makeEntry({
        terminalId: TerminalId.fromString('9d5f8e21-4a3b-4c6d-8e7f-0a1b2c3d4e5f'),
        observed: ObservedState.create({
          state: 'waiting_permission',
          lastEventAt: OBSERVED_AT,
          currentTool: 'Bash',
          lastAssistantMessage: null,
          cost: null,
          contextWindow: null,
          pid: null,
        }),
      }),
    ]);

    expect(presenter.shown).toEqual([]);
  });
});
