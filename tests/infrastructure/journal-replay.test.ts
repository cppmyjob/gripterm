import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  HookEventParser,
  ObservedState,
  SessionId,
  SessionRegistry,
  StorageLayout,
  TerminalId,
  TerminalStateMachine,
  projectObserved,
  readJournal,
} from '../../packages/core/src/index';
import type { HookDelivery, ProjectedEvent, TerminalEntry } from '../../packages/core/src/index';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { SESSION_UUID, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';

/**
 * The claim M2.4b actually has to make: a terminal's observed state can be
 * rebuilt from its journal, and the rebuild agrees with what the live window
 * had.
 *
 * Both halves run here over ONE history -- the registry as it happens, the
 * projector afterwards out of the file -- because that agreement is the only
 * thing that makes `observed.json` a cache rather than a source of truth. A test
 * that checked the projector alone would be checking that it agrees with itself.
 *
 * No fakes but the clock and the logger. The journal is a real directory and the
 * payloads are the shapes the CLI actually posts.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const SESSION = SessionId.fromString(SESSION_UUID);
const AT = new Date('2026-08-11T12:00:00.000Z');
const MINUTE_MS = 60_000;

const PAYLOADS: readonly string[] = [
  JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION_UUID, source: 'startup' }),
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: SESSION_UUID,
    user_input: 'rename the module',
  }),
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: SESSION_UUID,
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
  }),
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: SESSION_UUID,
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
  }),
  JSON.stringify({
    hook_event_name: 'Stop',
    session_id: SESSION_UUID,
    last_assistant_message: 'renamed it, and the tests pass',
  }),
];

let root: string;
let layout: StorageLayout;
let logger: RecordingLogger;
let clock: FixedClock;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-replay-'));
  layout = new StorageLayout(root);
  logger = new RecordingLogger();
  clock = new FixedClock(AT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function initial(): ObservedState {
  return ObservedState.create({
    state: 'launching',
    lastEventAt: AT,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

/**
 * Runs the history through a live window and its journal at the same time, the
 * way the receiver does: the clock is moved to each delivery's own moment, so
 * that the two paths are comparable at all.
 */
async function live(includeContent: boolean): Promise<TerminalEntry> {
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  registry.register(makeEntry({ observed: initial() }));

  const journal = new FileEventJournal({
    layout,
    logger,
    policy: { ...DEFAULT_JOURNAL_POLICY, includeContent },
  });

  for (const [index, raw] of PAYLOADS.entries()) {
    const delivery: HookDelivery = {
      terminalId: TERMINAL,
      receivedAt: new Date(AT.getTime() + index * MINUTE_MS),
      raw,
    };
    if (index > 0) {
      clock.advance(MINUTE_MS);
    }
    await journal.append(delivery);
    registry.receive(delivery);
  }

  const entry = registry.get(TERMINAL);
  if (entry === undefined) {
    throw new Error('the registry lost the terminal it was given');
  }
  return entry;
}

/** The replay side: the file, a parser, and nothing else. */
async function replay(): Promise<ReturnType<typeof projectObserved>> {
  const parser = new HookEventParser();
  const read = await readJournal(layout, TERMINAL);
  const events: ProjectedEvent[] = [];
  for (const line of read.lines) {
    const parsed = parser.parse(line.payload);
    if (parsed.status === 'parsed') {
      events.push({ event: parsed.event, at: line.at });
    }
  }

  return projectObserved({
    from: initial(),
    sessionId: SESSION,
    events,
    machine: new TerminalStateMachine(),
  });
}

describe('rebuilding observed state from the journal', () => {
  it('reproduces the live window exactly when the journal kept the bodies', async () => {
    const entry = await live(true);

    const projection = await replay();

    expect(projection.observed).toStrictEqual(entry.observed);
    expect(projection).toMatchObject({ applied: PAYLOADS.length, ignored: 0, foreign: 0 });
  });

  /*
   * With the content filter on -- the default -- the rebuild is exact in every
   * field but the texts, and it is exact about that too: the last assistant
   * message is `null` rather than stale or invented. Which is the honest price
   * of the setting, and the reason `observed.json` still carries the message
   * itself: the replay is what happens when that cache is LOST.
   */
  it('reproduces everything but the texts when the journal withheld them', async () => {
    const entry = await live(false);

    const projection = await replay();

    expect(entry.observed.lastAssistantMessage).toBe('renamed it, and the tests pass');
    expect(projection.observed.lastAssistantMessage).toBeNull();
    expect(projection.observed.state).toBe(entry.observed.state);
    expect(projection.observed.currentTool).toBe(entry.observed.currentTool);
    expect(projection.observed.lastEventAt).toStrictEqual(entry.observed.lastEventAt);
  });

  it('survives a day boundary, because the reader puts the days back in order', async () => {
    await live(true);
    const journal = new FileEventJournal({ layout, logger, policy: DEFAULT_JOURNAL_POLICY });
    // The next day, and a payload the filter keeps whole: the tool name is
    // structural.
    await journal.append({
      terminalId: TERMINAL,
      receivedAt: new Date(AT.getTime() + 24 * 60 * MINUTE_MS),
      raw: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: SESSION_UUID,
        tool_name: 'Read',
        tool_use_id: 'tu-2',
      }),
    });

    const projection = await replay();

    expect(projection.observed.currentTool).toBe('Read');
    expect(projection.observed.state).toBe('working');
  });
});
