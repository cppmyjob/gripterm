import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseWriter,
  DEFAULT_JOURNAL_POLICY,
  FileEventJournal,
  FileTerminalRepository,
  HookEventParser,
  InMemoryOwnerPresence,
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
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import {
  NEXT_SESSION_UUID,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeOwnerIdentity,
  makeOwnerRef,
} from '../helpers/domain-fixtures';

/**
 * П3, with everything but the editor: a person types `/clear`, and afterwards
 * the row, the record on disk and the journal all say the same thing.
 *
 * The whole claim of M2.8 is a chain, and every link of it already has a unit
 * test of its own -- the routing in `session-registry`, the queue in
 * `base-writer`, the two files in `file-terminal-repository`. What none of them
 * can say is that the chain is CONNECTED, and a chain of green links is exactly
 * how П3 could fail with a full suite: the rename happens in memory and never
 * leaves it, or leaves it and takes the notes with it.
 *
 * So this is the real base, on a real directory, driven by the payloads the CLI
 * actually posts. Only two fakes, and both are about determinism rather than
 * behaviour: the clock, so that the live path and the replay stamp the same
 * moments, and the presence, which is asked nothing here -- adoption is M2.10.
 *
 * **The writer is alive from before the terminal is registered**, and that is
 * not stand decoration -- it is the difference between this test proving
 * something and proving nothing. The record is on the disk BEFORE the `/clear`,
 * so the drift has to CHANGE a file that already exists; a stand that composed
 * its writer afterwards would hand it the already-renamed entry and write the
 * right answer once, passing just as well against a store that never updates a
 * record twice. Measured, not reasoned: that stand was written first, and two
 * deliberate breaks in the chain walked straight through it.
 *
 * WHEN a write happens is `base-writer.test.ts`'s question, answered there
 * against a fake scheduler. The flush here is `deactivate`'s.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const FIRST = SessionId.fromString(SESSION_UUID);
const SECOND = SessionId.fromString(NEXT_SESSION_UUID);
const AT = new Date('2026-08-12T10:00:00.000Z');
const MINUTE_MS = 60_000;

/** One `/clear`, in the order the CLI emits it (A10, measured 2026-08-10). */
const CONVERSATION: readonly string[] = [
  JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION_UUID, source: 'startup' }),
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: SESSION_UUID,
    user_input: 'split the token validator out',
  }),
  JSON.stringify({
    hook_event_name: 'Stop',
    session_id: SESSION_UUID,
    last_assistant_message: 'split it out and the tests pass',
  }),
  JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION_UUID, reason: 'clear' }),
  JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: NEXT_SESSION_UUID,
    source: 'clear',
  }),
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: NEXT_SESSION_UUID,
    user_input: 'now the migration',
  }),
];

/** A `Stop` from the conversation `/clear` replaced, arriving after it was replaced. */
const LATE = JSON.stringify({
  hook_event_name: 'Stop',
  session_id: SESSION_UUID,
  last_assistant_message: 'a message from a conversation that has ended',
});

let root: string;
let layout: StorageLayout;
let logger: RecordingLogger;
let clock: FixedClock;
let scheduler: FakeScheduler;
let registry: SessionRegistry;
let repository: FileTerminalRepository;
let journal: FileEventJournal;
let writer: BaseWriter;
let delivered = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-drift-'));
  layout = new StorageLayout(root);
  logger = new RecordingLogger();
  clock = new FixedClock(AT);
  scheduler = new FakeScheduler();
  delivered = 0;

  registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  const presence = new InMemoryOwnerPresence();
  await presence.announce(makeOwnerIdentity());
  repository = new FileTerminalRepository({
    layout,
    owner: makeOwnerRef(),
    presence,
    clock,
    logger,
  });
  journal = new FileEventJournal({ layout, logger, policy: DEFAULT_JOURNAL_POLICY });

  writer = newWriter();
  writer.start();
  registry.register(makeEntry({ observed: launching() }));
  // The state of the world every test below starts from: a terminal that exists,
  // whose record is already on the disk under the conversation it began with.
  await flush();
});

afterEach(async () => {
  // Before the directory goes, and not as tidiness: a test that ends without
  // flushing leaves a write in flight, and removing the tree under it turns
  // this suite into one that fails somewhere else, occasionally. Found by
  // running a mutation that made a write land later than it used to.
  await writer.stop();
  await rm(root, { recursive: true, force: true });
});

function launching(): ObservedState {
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
 * One hook body, to the journal and to the registry -- the two things the
 * receiver does with a delivery, in the order it does them.
 *
 * Each delivery gets its own minute, and the clock is moved with it. The live
 * path stamps records from the clock and the replay stamps them from the
 * journal, so a stand that let the two diverge would make them incomparable and
 * would look like a defect in the projector.
 */
async function deliver(raw: string): Promise<void> {
  const receivedAt = new Date(AT.getTime() + delivered * MINUTE_MS);
  delivered += 1;
  const delivery: HookDelivery = { terminalId: TERMINAL, receivedAt, raw };
  clock.advance(delivered === 1 ? 0 : MINUTE_MS);
  await journal.append(delivery);
  registry.receive(delivery);
}

async function deliverAll(raws: readonly string[]): Promise<void> {
  for (const raw of raws) {
    await deliver(raw);
  }
}

function newWriter(): BaseWriter {
  return new BaseWriter({ repository, registry, scheduler, logger });
}

/**
 * What `deactivate` does: stop taking changes and write down what is held.
 *
 * The writer that was listening while the events arrived is the one flushed --
 * the whole point is that its SUBSCRIPTION carried them. `stop()` is
 * deliberately terminal, so what follows a flush is a new writer taking over,
 * exactly as the next activation would.
 */
async function flush(): Promise<void> {
  const flushing = writer;
  const next = newWriter();
  // Handed over before anything is awaited, so that a failure inside the flush
  // still leaves `afterEach` a writer to stop.
  writer = next;
  await flushing.stop();
  expect(scheduler.live).toStrictEqual([]);
  next.start();
}

async function storedRecord(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(layout.recordFile(TERMINAL), 'utf8')) as Record<string, unknown>;
}

async function storedObserved(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(layout.observedFile(TERMINAL), 'utf8')) as Record<
    string,
    unknown
  >;
}

function held(): TerminalEntry {
  const entry = registry.get(TERMINAL);
  if (entry === undefined) {
    throw new Error('the registry lost the terminal it was given');
  }
  return entry;
}

/** The journal, folded back into the state it left behind. */
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
    from: launching(),
    // The conversation the JOURNAL starts in, which after a `/clear` is not the
    // one the record is having now. A replay that started from the current id
    // would count everything before the drift as somebody else's and rebuild the
    // terminal out of its last two events.
    sessionId: FIRST,
    events,
    machine: new TerminalStateMachine(),
  });
}

describe('a terminal whose conversation was replaced by /clear', () => {
  it('keeps its record, and the record follows the new conversation', async () => {
    // The record is already on the disk under the first conversation -- that is
    // what the terminal's own creation put there -- so what is being asked here
    // is whether a FILE THAT EXISTS is updated, not whether the right bytes can
    // be produced once everything has already happened.
    expect(await storedRecord()).toMatchObject({
      sessionId: SESSION_UUID,
      sessionIdHistory: [],
    });

    await deliverAll(CONVERSATION);
    await flush();

    const record = await storedRecord();
    expect(record.terminalId).toBe(TERMINAL_UUID);
    expect(record.sessionId).toBe(NEXT_SESSION_UUID);
    expect(record.sessionIdHistory).toStrictEqual([SESSION_UUID]);
  });

  it('keeps the task, the notes, the tags and the name a person put there', async () => {
    // The clause of П3 that the drift could quietly cost: `record.json` is the
    // one file in this store holding anything nothing can rebuild, and a rename
    // that rewrote it from an event would be the one write able to lose it.
    await deliverAll(CONVERSATION);

    await flush();

    expect((await storedRecord()).metadata).toStrictEqual({
      displayName: 'auth-refactor',
      task: 'Move token validation into its own service',
      notes: [{ at: new Date('2026-08-10T09:00:00.000Z').getTime(), text: 'Read ADR-014 first' }],
      tags: ['backend'],
      color: 'terminal.ansiCyan',
    });
  });

  it('is one record and not two, in memory and on the disk alike', async () => {
    // A phantom terminal is the failure §4.6 is written against: the new
    // conversation has an id nothing on this machine has seen, and a store keyed
    // on that id rather than on the terminal's would hold two rows for one
    // terminal -- one of them frozen, the other without a task.
    await deliverAll(CONVERSATION);

    await flush();

    expect(await readdir(layout.terminalsDir)).toStrictEqual([TERMINAL_UUID]);
    expect(registry.own()).toHaveLength(1);
  });

  it('comes back out of the end its own /clear announced', async () => {
    // `SessionEnd(reason: clear)` arrives first and is a witnessed end. A record
    // left in it would be a row saying "ended" about a terminal somebody is
    // typing into -- П1, brought back by the feature meant to prevent it.
    await deliverAll(CONVERSATION);

    await flush();

    expect((await storedObserved()).state).toBe('working');
  });

  it('is read back out of the store still answering to the conversation it left', async () => {
    await deliverAll(CONVERSATION);
    await flush();

    const [entry] = await repository.readAll();

    expect(entry?.matchesSession(FIRST)).toBe(true);
    expect(entry?.matchesSession(SECOND)).toBe(true);
    // The rename is not an adoption, and nothing else advances this number: a
    // record whose revision moved on a `/clear` would turn every other window's
    // compare-and-swap into a retry over an event that concerns none of them.
    expect(entry?.revision).toBe(0);
  });

  it('is not killed by a message still in flight from the conversation it left', async () => {
    await deliverAll(CONVERSATION);
    await flush();
    const before = await storedRecord();
    const observedBefore = await storedObserved();

    await deliver(LATE);
    await flush();

    expect(logger.warnings.map((line) => line.message)).toContain(
      'an event arrived from a session this terminal has left'
    );
    expect(await storedRecord()).toStrictEqual(before);
    expect(await storedObserved()).toStrictEqual(observedBefore);
  });

  it('rebuilds out of its journal into the state the live window is holding', async () => {
    // The journal spans the drift, so this is also the answer to a question
    // M2.13 will have to ask: `session_id` and `source` are structural keys, so
    // they survive `includeContent: false` -- a journal with the texts withheld
    // still knows which conversation each line belongs to.
    await deliverAll(CONVERSATION);

    const projection = await replay();

    expect(projection.observed).toStrictEqual(held().observed);
    expect(projection).toMatchObject({ applied: CONVERSATION.length, ignored: 0, foreign: 0 });
  });

  it('refuses the same late message on the replay path as on the live one', async () => {
    await deliverAll(CONVERSATION);
    const live = held().observed;

    await deliver(LATE);
    const projection = await replay();

    expect(held().observed).toStrictEqual(live);
    expect(projection.observed).toStrictEqual(live);
    expect(projection).toMatchObject({ foreign: 1 });
  });
});
