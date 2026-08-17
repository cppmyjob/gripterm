import {
  ObservedState,
  SessionId,
  TerminalId,
  endOwnTerminals,
  type TerminalEngine,
  type TerminalEntry,
} from '../../packages/core/src/index';
import { SESSION_UUID, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';
import { InMemoryTerminalGateway, RecordingLogger } from '../helpers/port-fakes';

/**
 * What a window does to its own processes on the way out (O4).
 *
 * Two acts, and the ORDER of them is the rule this file is mostly about: the
 * pids are read while the gateway still knows its terminals, and only then is
 * the gateway told to end them. Reversed, the second act has nothing to work
 * from -- a gateway that has disposed its handles knows no terminals -- and the
 * backstop would be a loop over an empty list that no assertion about the first
 * act would notice.
 *
 * WHY there is a second act at all. `pty.kill()` is asynchronous in its effect,
 * and the extension host it was called from may be gone microseconds later; a
 * synchronous `process.kill` on the pid we wrote down is the one thing that
 * cannot be overtaken by the window closing. On Windows it is belt and braces --
 * closing the pseudoconsole takes the process down with it, measured in M3.2(7)
 * -- and it is the whole of the promise anywhere else.
 *
 * WHY it reads `listKnown()` rather than the record's own `engine` field. Both
 * would answer the same question here, and two answers to one question is how
 * one of them stops being checked (the lesson of M2.11's mutation run). The
 * gateway's list is the authority, because it IS this window's set of running
 * terminals: a record adopted but never started here carries a pid from another
 * window's life, and no rule about the field it stores would say so.
 */

const OTHER_TERMINAL = '9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a';
const OTHER_SESSION = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const CLAUDE_PID = 4242;
const SECOND_PID = 4343;

function entryFor(id: string, pid: number | null, engine: TerminalEngine = 'own'): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(id),
    sessionId: SessionId.fromString(id === TERMINAL_UUID ? SESSION_UUID : OTHER_SESSION),
    owner: makeOwnerRef(),
    engine,
    observed: ObservedState.create({
      state: 'idle',
      lastEventAt: new Date('2026-08-17T09:59:00.000Z'),
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid,
    }),
  });
}

interface Parts {
  readonly gateway: InMemoryTerminalGateway;
  readonly logger: RecordingLogger;
  readonly signalled: number[];
  readonly refuse: Set<number>;
  readonly end: (pid: number) => void;
}

function build(engine: TerminalEngine): Parts {
  const gateway = new InMemoryTerminalGateway();
  gateway.engine = engine;
  const signalled: number[] = [];
  const refuse = new Set<number>();
  return {
    gateway,
    logger: new RecordingLogger(),
    signalled,
    refuse,
    end: (pid: number): void => {
      if (refuse.has(pid)) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      signalled.push(pid);
    },
  };
}

/** A terminal this gateway is running now, as `create` leaves it. */
async function running(gateway: InMemoryTerminalGateway, id: string): Promise<void> {
  await gateway.create({
    terminalId: TerminalId.fromString(id),
    name: 'auth-refactor',
    cwd: 'D:/Projects/foo',
    env: {},
    shellPath: 'C:/Users/x/.local/bin/claude.exe',
    shellArgs: [],
  });
}

describe('the processes a window ends on its way out', () => {
  it('ends the process of every terminal of its own that it is running', async () => {
    const parts = build('own');
    await running(parts.gateway, TERMINAL_UUID);
    await running(parts.gateway, OTHER_TERMINAL);

    const report = endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, CLAUDE_PID), entryFor(OTHER_TERMINAL, SECOND_PID)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(parts.signalled).toStrictEqual([CLAUDE_PID, SECOND_PID]);
    expect(report.ended).toStrictEqual([CLAUDE_PID, SECOND_PID]);
    expect(parts.gateway.disposed).toBe(true);
  });

  it('reads the pids BEFORE the terminals are ended, or there are none left to read', async () => {
    // The fake forgets its terminals on dispose exactly as the real gateway
    // does. If this ever runs the other way round, `listKnown()` is empty by the
    // time it is asked and nothing is signalled at all.
    const parts = build('own');
    await running(parts.gateway, TERMINAL_UUID);

    endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, CLAUDE_PID)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(parts.signalled).toStrictEqual([CLAUDE_PID]);
  });

  it('does nothing at all under the editor\'s engine', async () => {
    // The editor's terminals are the editor's, and a `claude` in one of them
    // outlives the extension host on purpose (O5, M2.16). A window leaving must
    // not end a conversation it does not own the process of.
    const parts = build('editor');
    await running(parts.gateway, TERMINAL_UUID);

    const report = endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, CLAUDE_PID)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(report.ended).toStrictEqual([]);
    expect(parts.signalled).toStrictEqual([]);
    expect(parts.gateway.disposed).toBe(false);
  });

  it('leaves the pid of a record it is not running a terminal for', async () => {
    // A record this window adopted and never started: its pid belongs to
    // another window's life, and whoever holds that number now is a stranger.
    const parts = build('own');
    await running(parts.gateway, TERMINAL_UUID);

    endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, CLAUDE_PID), entryFor(OTHER_TERMINAL, SECOND_PID)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(parts.signalled).toStrictEqual([CLAUDE_PID]);
  });

  it('says so when it is running a terminal it was never told a pid for', async () => {
    const parts = build('own');
    await running(parts.gateway, TERMINAL_UUID);

    const report = endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, null)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(report.ended).toStrictEqual([]);
    expect(parts.logger.infos.map((line) => line.message)).toContainEqual(
      expect.stringContaining('without knowing which process')
    );
  });

  it('carries on when the platform refuses a pid, and reports the one it refused', async () => {
    const parts = build('own');
    await running(parts.gateway, TERMINAL_UUID);
    await running(parts.gateway, OTHER_TERMINAL);
    parts.refuse.add(CLAUDE_PID);

    const report = endOwnTerminals({
      gateway: parts.gateway,
      entries: [entryFor(TERMINAL_UUID, CLAUDE_PID), entryFor(OTHER_TERMINAL, SECOND_PID)],
      endProcess: parts.end,
      logger: parts.logger,
    });

    expect(report.ended).toStrictEqual([SECOND_PID]);
    expect(report.refused).toStrictEqual([CLAUDE_PID]);
  });
});
