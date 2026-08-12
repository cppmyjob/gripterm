import {
  HumanMetadata,
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalEntry,
  TerminalId,
  ValidationError,
} from '../../packages/core/src/index';
import {
  CREATED_AT,
  NEXT_SESSION_UUID,
  OBSERVED_AT,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeObserved,
  makeOwnerRef,
} from '../helpers/domain-fixtures';

const CLOSED_AT = new Date('2026-08-10T11:00:00.000Z');

describe('TerminalEntry.create', () => {
  it('starts at revision zero, with no history and open', () => {
    const entry = makeEntry();

    expect(entry.revision).toBe(0);
    expect(entry.sessionIdHistory).toStrictEqual([]);
    expect(entry.closedAt).toBeNull();
    expect(entry.isRestorable()).toBe(true);
  });

  it('refuses an invalid createdAt', () => {
    expect(() => makeEntry({ createdAt: new Date('nope') })).toThrow(ValidationError);
  });

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
  ])('refuses a revision that is %s', (_label, revision) => {
    expect(() => makeEntry({ revision })).toThrow(ValidationError);
  });

  it('refuses a history that already contains the current session id', () => {
    // Otherwise the same id is both current and past, and the lookup that
    // history exists for -- finding the terminal a late event belongs to --
    // has two answers.
    expect(() =>
      makeEntry({ sessionIdHistory: [SessionId.fromString(SESSION_UUID)] })
    ).toThrow(ValidationError);
  });

  it('refuses a closedAt that precedes createdAt', () => {
    expect(() => makeEntry({ closedAt: new Date(CREATED_AT.getTime() - 1) })).toThrow(
      ValidationError
    );
  });
});

describe('immutability', () => {
  it('freezes the instance', () => {
    const entry = makeEntry();

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { revision: number }).revision = 9;
    }).toThrow(TypeError);
  });

  it('does not share the Dates it was given', () => {
    const createdAt = new Date(CREATED_AT.getTime());
    const entry = makeEntry({ createdAt, closedAt: CLOSED_AT });

    createdAt.setTime(0);

    expect(entry.createdAt.getTime()).toBe(CREATED_AT.getTime());
    expect(entry.closedAt?.getTime()).toBe(CLOSED_AT.getTime());
  });

  it('does not share the Dates it hands out', () => {
    const entry = makeEntry({ closedAt: CLOSED_AT });

    entry.createdAt.setTime(0);
    entry.closedAt?.setTime(0);

    expect(entry.createdAt.getTime()).toBe(CREATED_AT.getTime());
    expect(entry.closedAt?.getTime()).toBe(CLOSED_AT.getTime());
  });

  it('freezes and copies the session id history', () => {
    const history = [SessionId.fromString(NEXT_SESSION_UUID)];
    const entry = makeEntry({ sessionIdHistory: history });

    history.push(SessionId.fromString(TERMINAL_UUID));

    expect(entry.sessionIdHistory).toHaveLength(1);
    expect(() => (entry.sessionIdHistory as SessionId[]).push(entry.sessionId)).toThrow(TypeError);
  });
});

describe('withObserved', () => {
  it('returns a new instance and leaves the original alone', () => {
    const entry = makeEntry();
    const next = ObservedState.create({
      state: 'working',
      lastEventAt: OBSERVED_AT,
      currentTool: 'Bash',
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: 21344,
    });

    const updated = entry.withObserved(next);

    expect(updated).not.toBe(entry);
    expect(updated.observed.state).toBe('working');
    expect(entry.observed.state).toBe('idle');
  });

  it('does NOT advance the revision', () => {
    // The two files exist precisely to separate a frequently rewritten
    // observed state from record.json; bumping the revision here would drag
    // record.json into every debounced write.
    expect(makeEntry().withObserved(makeObserved()).revision).toBe(0);
  });
});

describe('withMetadata', () => {
  it('replaces the human block and keeps everything else', () => {
    const entry = makeEntry();
    const updated = entry.withMetadata(
      HumanMetadata.create({
        displayName: 'renamed',
        task: null,
        notes: [],
        tags: [],
        color: null,
      })
    );

    expect(updated.metadata.displayName).toBe('renamed');
    expect(updated.terminalId.equals(entry.terminalId)).toBe(true);
    expect(entry.metadata.displayName).toBe('auth-refactor');
  });
});

describe('withSessionId', () => {
  it('pushes the old id into the history', () => {
    const entry = makeEntry();
    const drifted = entry.withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    expect(drifted.sessionId.value).toBe(NEXT_SESSION_UUID);
    expect(drifted.sessionIdHistory.map((id) => id.value)).toStrictEqual([SESSION_UUID]);
    expect(drifted.terminalId.equals(entry.terminalId)).toBe(true);
    expect(drifted.metadata.equals(entry.metadata)).toBe(true);
  });

  it('is a no-op when the id has not moved', () => {
    const entry = makeEntry();

    expect(entry.withSessionId(SessionId.fromString(SESSION_UUID))).toBe(entry);
  });

  it('returns to an id the terminal already used, by swapping it with the current one', () => {
    // This refused until 2026-08-12, and the refusal rested on "the CLI never
    // reissues an id". A19 measured otherwise: `/resume <id>` inside the
    // terminal sends `SessionEnd(reason: resume)` and then
    // `SessionStart(source: resume)` carrying the id the terminal ALREADY had.
    //
    // A swap and not an append, because the invariant is what made the refusal
    // reasonable in the first place: one id must never be both current and
    // past, or the lookup stops being a lookup.
    const drifted = makeEntry().withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    const returned = drifted.withSessionId(SessionId.fromString(SESSION_UUID));

    expect(returned.sessionId.value).toBe(SESSION_UUID);
    expect(returned.sessionIdHistory.map((id) => id.value)).toStrictEqual([NEXT_SESSION_UUID]);
    // Both are still this terminal's, which is what keeps an event still in
    // flight from the conversation it just left routable to this record.
    expect(returned.matchesSession(SessionId.fromString(NEXT_SESSION_UUID))).toBe(true);
    expect(returned.matchesSession(SessionId.fromString(SESSION_UUID))).toBe(true);
  });

  it('leaves the history in the order the conversations were left', () => {
    const third = 'b7c8d9e0-3f4a-4b5c-8d6e-7f8a9b0c1d2e';
    const twice = makeEntry()
      .withSessionId(SessionId.fromString(NEXT_SESSION_UUID))
      .withSessionId(SessionId.fromString(third));

    const returned = twice.withSessionId(SessionId.fromString(SESSION_UUID));

    expect(returned.sessionId.value).toBe(SESSION_UUID);
    // The first conversation leaves the history because it is current again;
    // the other two keep their order, most recently left last.
    expect(returned.sessionIdHistory.map((id) => id.value)).toStrictEqual([
      NEXT_SESSION_UUID,
      third,
    ]);
  });

  it('still matches events addressed to a previous session', () => {
    const drifted = makeEntry().withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    expect(drifted.matchesSession(SessionId.fromString(SESSION_UUID))).toBe(true);
    expect(drifted.matchesSession(SessionId.fromString(NEXT_SESSION_UUID))).toBe(true);
    expect(drifted.matchesSession(SessionId.fromString(TERMINAL_UUID))).toBe(false);
  });
});

/*
 * The same question asked from the other side, and it is here rather than in
 * either of its two callers because they must not answer it differently. What
 * the CLI hands over is a LIST of running conversations, and both readers of
 * that list -- the restore planner, deciding whether a record may be started,
 * and the reconciler, deciding whether one lost its process -- have to count a
 * conversation this terminal used to be as this terminal's own.
 */
describe('claimsAnyOf', () => {
  it('recognises the conversation it is having now', () => {
    expect(makeEntry().claimsAnyOf(new Set([SESSION_UUID]))).toBe(true);
  });

  it('recognises a conversation it used to be, because `/clear` does not end it', () => {
    // The old conversation is still in the CLI's store and still resumable. A
    // record that stopped answering for it would let something start a second
    // process on an id we handed out.
    const drifted = makeEntry().withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    expect(drifted.claimsAnyOf(new Set([SESSION_UUID]))).toBe(true);
    expect(drifted.claimsAnyOf(new Set([NEXT_SESSION_UUID]))).toBe(true);
  });

  it('claims nothing out of a set that does not name it', () => {
    const drifted = makeEntry().withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    expect(drifted.claimsAnyOf(new Set([TERMINAL_UUID]))).toBe(false);
    expect(drifted.claimsAnyOf(new Set())).toBe(false);
  });
});

describe('adoptedBy', () => {
  it('hands the record to a different owner', () => {
    const entry = makeEntry();
    const adopted = entry.adoptedBy(makeOwnerRef('window-activation-2'));

    expect(adopted.owner.ownerId.value).toBe('window-activation-2');
    expect(entry.owner.ownerId.value).toBe('window-activation-1');
  });

  it('advances the revision, unlike every other change to the record', () => {
    // Adoption IS the compare-and-swap: a caller reads revision R, adopts with
    // `expected: R` and stores the result. Leave the number where it was and
    // two windows adopting the same abandoned terminal both pass their check
    // and both start `claude --resume` on one conversation. Found while wiring
    // the repository in M1.5 -- the comment on `revision` promised a mechanism
    // the aggregate did not have.
    const entry = makeEntry({ revision: 7 });

    expect(entry.adoptedBy(makeOwnerRef('window-activation-2')).revision).toBe(8);
  });

  it('refuses the current owner, living owners included -- even itself', () => {
    const entry = makeEntry();

    expect(() => entry.adoptedBy(makeOwnerRef('window-activation-1'))).toThrow(ValidationError);
  });

  it('accepts a service owner, which is what the field exists for', () => {
    const adopted = makeEntry().adoptedBy(
      OwnerRef.create({
        kind: 'service',
        ownerId: OwnerId.fromString('orchestrator'),
        editorKind: 'none',
        workspaceFolder: null,
      })
    );

    expect(adopted.owner.kind).toBe('service');
  });
});

describe('withClosed', () => {
  it('closes, and stops being restorable', () => {
    const closed = makeEntry().withClosed(CLOSED_AT);

    expect(closed.closedAt?.getTime()).toBe(CLOSED_AT.getTime());
    expect(closed.isRestorable()).toBe(false);
  });

  it('is idempotent: the first close wins', () => {
    const closed = makeEntry().withClosed(CLOSED_AT);
    const again = closed.withClosed(new Date(CLOSED_AT.getTime() + 60_000));

    expect(again).toBe(closed);
    expect(again.closedAt?.getTime()).toBe(CLOSED_AT.getTime());
  });

  it('refuses a close that precedes creation', () => {
    expect(() => makeEntry().withClosed(new Date(CREATED_AT.getTime() - 1))).toThrow(
      ValidationError
    );
  });

  it('refuses an invalid closedAt, whether it arrives at create or at close', () => {
    expect(() => makeEntry({ closedAt: new Date('nope') })).toThrow(ValidationError);
    expect(() => makeEntry().withClosed(new Date('nope'))).toThrow(ValidationError);
  });

  it('is not set by a process exiting -- only a mutator sets it', () => {
    // Our terminals are transient and die on every editor shutdown. Were
    // closedAt tied to process exit, everything would be rubbish after the
    // first one and isRestorable would have nothing left to say.
    const entry = makeEntry().withObserved(
      ObservedState.create({
        state: 'ended',
        lastEventAt: OBSERVED_AT,
        currentTool: null,
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      })
    );

    expect(entry.observed.state).toBe('ended');
    expect(entry.closedAt).toBeNull();
    expect(entry.isRestorable()).toBe(true);
  });
});

describe('the aggregate as a whole', () => {
  it('keeps identity and human metadata across a chain of changes', () => {
    const entry = makeEntry();

    const evolved = entry
      .withObserved(makeObserved())
      .withSessionId(SessionId.fromString(NEXT_SESSION_UUID))
      .adoptedBy(makeOwnerRef('window-activation-2'));

    expect(evolved.terminalId.equals(TerminalId.fromString(TERMINAL_UUID))).toBe(true);
    expect(evolved.metadata.equals(entry.metadata)).toBe(true);
    expect(evolved.launch).toBe(entry.launch);
    expect(evolved.createdAt.getTime()).toBe(CREATED_AT.getTime());
  });

  it('accepts a stored revision and history when read back from disk', () => {
    const restored = TerminalEntry.create({
      terminalId: TerminalId.fromString(TERMINAL_UUID),
      sessionId: SessionId.fromString(NEXT_SESSION_UUID),
      sessionIdHistory: [SessionId.fromString(SESSION_UUID)],
      owner: makeOwnerRef(),
      metadata: makeEntry().metadata,
      launch: makeEntry().launch,
      observed: makeObserved(),
      createdAt: CREATED_AT,
      revision: 7,
    });

    expect(restored.revision).toBe(7);
    expect(restored.matchesSession(SessionId.fromString(SESSION_UUID))).toBe(true);
  });
});
