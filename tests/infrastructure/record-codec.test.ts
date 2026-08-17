import {
  ContextWindowSnapshot,
  CostSnapshot,
  HumanMetadata,
  LaunchRecipe,
  Note,
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  decodeEntry,
  encodeObserved,
  encodeRecord,
} from '../../packages/core/src/index';
import {
  CREATED_AT,
  NEXT_SESSION_UUID,
  OBSERVED_AT,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
} from '../helpers/domain-fixtures';

/**
 * The file format, and the one place a record written by yesterday's build
 * meets today's rules.
 *
 * Every test here is about the same question: what happens to a record that is
 * not exactly what we expected. The answers are deliberately not uniform --
 * losing `record.json` loses the terminal, losing `observed.json` loses a cache
 * -- and telling the two apart is the whole design.
 */

function loaded(record: unknown, observed?: unknown): ReturnType<typeof decodeEntry> {
  return decodeEntry(record, observed);
}

function reasonOf(decode: ReturnType<typeof decodeEntry>): string {
  return decode.kind === 'broken' ? decode.reason : `not broken: ${decode.kind}`;
}

describe('storing a terminal and reading it back', () => {
  it('survives a full round trip through JSON, field for field', () => {
    const rich = makeEntry({
      sessionIdHistory: [SessionId.fromString(NEXT_SESSION_UUID)],
      closedAt: new Date(CREATED_AT.getTime() + 1_000),
      revision: 7,
      observed: ObservedState.create({
        state: 'waiting_permission',
        lastEventAt: OBSERVED_AT,
        currentTool: 'Bash',
        lastAssistantMessage: 'I need permission to run this',
        cost: CostSnapshot.create(1.25, 90_000),
        contextWindow: ContextWindowSnapshot.create(42.5),
        pid: 13_988,
      }),
    });

    // Through a real serialisation, not just through the objects: a field that
    // JSON cannot carry would pass an in-memory comparison and fail on disk.
    const record: unknown = JSON.parse(JSON.stringify(encodeRecord(rich)));
    const observed: unknown = JSON.parse(JSON.stringify(encodeObserved(rich.observed)));

    const decoded = loaded(record, observed);
    expect(decoded.kind).toBe('ok');
    if (decoded.kind !== 'ok') {
      return;
    }

    const back = decoded.entry;
    expect(decoded.observed).toStrictEqual({ kind: 'stored' });
    expect(back.terminalId.value).toBe(rich.terminalId.value);
    expect(back.sessionId.value).toBe(rich.sessionId.value);
    expect(back.sessionIdHistory.map((id) => id.value)).toStrictEqual([NEXT_SESSION_UUID]);
    expect(back.owner.equals(rich.owner)).toBe(true);
    expect(back.metadata.equals(rich.metadata)).toBe(true);
    expect(back.launch).toStrictEqual(rich.launch);
    expect(back.observed).toStrictEqual(rich.observed);
    expect(back.createdAt).toStrictEqual(rich.createdAt);
    expect(back.closedAt).toStrictEqual(rich.closedAt);
    expect(back.revision).toBe(7);
  });

  it('carries a launch recipe that uses every field', () => {
    const entry = makeEntry({
      launch: LaunchRecipe.create({
        cwd: 'D:/Projects/foo',
        addDirs: ['D:/Projects/shared'],
        permissionMode: 'plan',
        agent: 'reviewer',
        model: 'claude-opus-5',
        worktree: 'D:/Projects/foo/.worktrees/x',
        mcpConfigPaths: ['D:/Projects/foo/.mcp.json'],
        appendSystemPrompt: 'be brief',
        extraEnv: { GRIPTERM_TOKEN: 'secret' },
      }),
    });

    const decoded = loaded(JSON.parse(JSON.stringify(encodeRecord(entry))));

    expect(decoded.kind === 'ok' ? decoded.entry.launch : null).toStrictEqual(entry.launch);
  });

  it('keeps the notes a person wrote, with their timestamps', () => {
    const entry = makeEntry({
      metadata: HumanMetadata.create({
        displayName: 'auth',
        task: null,
        notes: [Note.create(CREATED_AT, 'first'), Note.create(OBSERVED_AT, 'second')],
        tags: ['a', 'b'],
        color: null,
      }),
    });

    const decoded = loaded(JSON.parse(JSON.stringify(encodeRecord(entry))));

    expect(decoded.kind === 'ok' ? decoded.entry.metadata.equals(entry.metadata) : false).toBe(true);
  });
});

describe('a record that is not what we expected', () => {
  const good = JSON.parse(JSON.stringify(encodeRecord(makeEntry()))) as Record<string, unknown>;

  function without(field: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(good).filter(([key]) => key !== field));
  }

  it.each([
    ['null', null],
    ['a number', 7],
    ['a string', '{}'],
    ['an array', []],
    ['nothing at all', undefined],
  ])('refuses a document that is %s', (_name, document) => {
    const decode = loaded(document);
    expect(decode.kind).toBe('broken');
    expect(reasonOf(decode)).toContain('record must be a JSON object');
  });

  it.each(['terminalId', 'sessionId', 'createdAt', 'revision', 'owner', 'metadata', 'launch'])(
    'refuses a record with no %s, because the terminal cannot exist without it',
    (field) => {
      expect(loaded(without(field)).kind).toBe('broken');
    }
  );

  it('refuses an id that is not a uuid, rather than storing a terminal nothing can address', () => {
    expect(reasonOf(loaded({ ...good, terminalId: 'not-a-uuid' }))).toContain('terminalId');
  });

  it('refuses a creation time that is not a number', () => {
    expect(reasonOf(loaded({ ...good, createdAt: '2026-08-10' }))).toContain('finite number');
  });

  it('refuses an owner kind, editor or permission mode this build does not know', () => {
    expect(reasonOf(loaded({ ...good, owner: { ...(good.owner as object), kind: 'daemon' } })))
      .toContain('owner.kind');
    expect(
      reasonOf(loaded({ ...good, owner: { ...(good.owner as object), editorKind: 'emacs' } }))
    ).toContain('owner.editorKind');
    expect(
      reasonOf(loaded({ ...good, launch: { ...(good.launch as object), permissionMode: 'default' } }))
    ).toContain('permissionMode');
  });

  it('refuses an environment block whose values are not all strings', () => {
    expect(
      reasonOf(loaded({ ...good, launch: { ...(good.launch as object), extraEnv: { A: 1 } } }))
    ).toContain('extraEnv');
  });

  it('refuses a tag list that is not a list of strings', () => {
    expect(
      reasonOf(loaded({ ...good, metadata: { ...(good.metadata as object), tags: [1, 2] } }))
    ).toContain('metadata.tags');
  });

  it('refuses notes that are not an array, and a note that is not an object', () => {
    expect(
      reasonOf(loaded({ ...good, metadata: { ...(good.metadata as object), notes: 'none' } }))
    ).toContain('metadata.notes');
    expect(
      reasonOf(loaded({ ...good, metadata: { ...(good.metadata as object), notes: ['none'] } }))
    ).toContain('metadata.notes[]');
  });

  it('refuses a session id that is also in its own history, because the aggregate does', () => {
    expect(loaded({ ...good, sessionIdHistory: [SESSION_UUID] }).kind).toBe('broken');
  });

  /*
   * The lenient half, and it is lenient on purpose. A record missing a colour is
   * still a record; refusing it would throw away the task and the notes with it,
   * and those are the one thing in this store that nothing can rebuild.
   */
  it('reads a record that simply has nothing to say in its optional fields', () => {
    const sparse = {
      terminalId: TERMINAL_UUID,
      sessionId: SESSION_UUID,
      owner: { kind: 'window', ownerId: 'w1', editorKind: 'unknown' },
      metadata: { displayName: 'nameless' },
      launch: { cwd: 'D:/Projects/foo' },
      createdAt: CREATED_AT.getTime(),
      revision: 0,
    };

    const decoded = loaded(sparse);

    expect(decoded.kind).toBe('ok');
    if (decoded.kind !== 'ok') {
      return;
    }
    expect(decoded.entry.metadata.tags).toStrictEqual([]);
    expect(decoded.entry.metadata.notes).toStrictEqual([]);
    expect(decoded.entry.metadata.color).toBeNull();
    expect(decoded.entry.sessionIdHistory).toStrictEqual([]);
    expect(decoded.entry.launch.extraEnv).toStrictEqual({});
    expect(decoded.entry.closedAt).toBeNull();
  });

  it('treats an explicit null in an optional field the same as its absence', () => {
    const decoded = loaded({
      ...good,
      closedAt: null,
      metadata: { ...(good.metadata as object), task: null, color: null, notes: null },
    });

    expect(decoded.kind).toBe('ok');
  });
});

describe('the observed half, which is allowed to be lost', () => {
  const record = JSON.parse(JSON.stringify(encodeRecord(makeEntry()))) as Record<string, unknown>;

  function provenance(observed?: unknown): unknown {
    const decode = loaded(record, observed);
    return decode.kind === 'ok' ? decode.observed : decode;
  }

  it('stands in for an observed.json that is not there, and says so', () => {
    const decode = loaded(record, undefined);

    expect(decode.kind).toBe('ok');
    if (decode.kind !== 'ok') {
      return;
    }
    expect(decode.observed).toStrictEqual({
      kind: 'recovered',
      reason: 'there is no observed.json',
    });
    // `degraded` is the literal truth after losing the cache, and the timestamp
    // is the record's own creation rather than now: stamping it with now would
    // claim we had just heard from a terminal we have heard nothing from.
    expect(decode.entry.observed.state).toBe('degraded');
    expect(decode.entry.observed.lastEventAt).toStrictEqual(CREATED_AT);
    expect(decode.entry.observed.pid).toBeNull();
  });

  it.each([
    ['not an object', 'nonsense'],
    ['an array', []],
    ['missing its state', { lastEventAt: 1 }],
    ['carrying a state this build does not store', { state: 'napping', lastEventAt: 1 }],
    ['carrying detached, which is never written down', { state: 'detached', lastEventAt: 1 }],
    ['missing its timestamp', { state: 'idle' }],
    ['carrying a cost that is not a number', { state: 'idle', lastEventAt: 1, cost: { totalUsd: 'free', durationMs: 1 } }],
    ['carrying a negative cost the aggregate refuses', { state: 'idle', lastEventAt: 1, cost: { totalUsd: -1, durationMs: 1 } }],
    ['carrying a pid of zero', { state: 'idle', lastEventAt: 1, pid: 0 }],
  ])('recovers rather than losing the terminal when observed.json is %s', (_name, observed) => {
    const decode = loaded(record, observed);

    expect(decode.kind).toBe('ok');
    expect(decode.kind === 'ok' ? decode.observed.kind : null).toBe('recovered');
    expect(decode.kind === 'ok' ? decode.entry.observed.state : null).toBe('degraded');
  });

  it('keeps a snapshot that is merely sparse', () => {
    expect(
      provenance({ state: 'working', lastEventAt: OBSERVED_AT.getTime(), currentTool: 'Bash' })
    ).toStrictEqual({ kind: 'stored' });
  });

  /*
   * A terminal whose statusline has not fired yet has no cost at all, which is
   * a different thing from a cost of zero -- so the absence has to survive the
   * write as `null` rather than as an object full of zeroes.
   */
  it('writes an empty snapshot as empty rather than as zeroes', () => {
    const empty = ObservedState.create({
      state: 'launching',
      lastEventAt: OBSERVED_AT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    });

    expect(encodeObserved(empty)).toStrictEqual({
      state: 'launching',
      lastEventAt: OBSERVED_AT.getTime(),
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    });
    expect(loaded(record, encodeObserved(empty)).kind).toBe('ok');
  });

  it('round-trips a full snapshot', () => {
    const state = ObservedState.create({
      state: 'turn_failed',
      lastEventAt: OBSERVED_AT,
      currentTool: 'Edit',
      lastAssistantMessage: 'that did not work',
      cost: CostSnapshot.create(0, 0),
      contextWindow: ContextWindowSnapshot.create(101),
      pid: 4242,
    });

    const decode = loaded(record, JSON.parse(JSON.stringify(encodeObserved(state))));

    expect(decode.kind === 'ok' ? decode.entry.observed : null).toStrictEqual(state);
  });

  it('names the reason it had to recover, so the log can say more than "lost"', () => {
    const decode = loaded(record, { state: 'napping', lastEventAt: 1 });

    expect(decode.kind === 'ok' && decode.observed.kind === 'recovered' ? decode.observed.reason : '')
      .toContain('not a state this build stores');
  });
});

describe('the aggregate stays the only definition of valid', () => {
  it('refuses what the entity refuses, without repeating its rule', () => {
    const owner = OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString('w1'),
      editorKind: 'vscode',
      workspaceFolder: null,
    });
    const record = encodeRecord(makeEntry({ owner }));

    // A blank display name is refused by `HumanMetadata`, not by a second list
    // of rules kept here -- which is why there is no test asserting the message.
    const decode = loaded({
      ...JSON.parse(JSON.stringify(record)),
      metadata: { displayName: '   ' },
    });

    expect(decode.kind).toBe('broken');
  });
});

/**
 * The engine field, whose absence has to mean something specific.
 *
 * This is the one field in the record that decides whether a process may be
 * killed, so both directions of the rollback were thought about rather than one:
 *
 *  * A record written by a build that had no engine field, read by this one:
 *    absence means `editor`, and the reconciler kills nothing. Bumping
 *    `STORAGE_SCHEMA_VERSION` for it was rejected -- prior builds would then
 *    refuse the whole base (`storage-migrator.ts:122`).
 *  * A record written by a LATER build, read by this one: a value we cannot read
 *    makes the record broken, which loses one row from the list and logs why
 *    (`file-terminal-repository.ts:270`), and leaves the file itself untouched
 *    so that rolling forward reads it again. Calling an unreadable engine
 *    `editor` would be this build asserting knowledge it does not have about a
 *    decision that ends a process.
 */
describe('the engine that made the terminal', () => {
  const good = JSON.parse(JSON.stringify(encodeRecord(makeEntry()))) as Record<string, unknown>;

  it('writes the engine into the document', () => {
    expect(encodeRecord(makeEntry({ engine: 'own' })).engine).toBe('own');
  });

  it('survives a round trip', () => {
    const decode = loaded(JSON.parse(JSON.stringify(encodeRecord(makeEntry({ engine: 'own' })))));

    expect(decode.kind).toBe('ok');
    expect(decode.kind === 'ok' ? decode.entry.engine : null).toBe('own');
  });

  it('reads a record written before the field existed as the editor engine', () => {
    const older = Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'engine'));

    const decode = loaded(older);

    expect(decode.kind).toBe('ok');
    expect(decode.kind === 'ok' ? decode.entry.engine : null).toBe('editor');
  });

  it.each(['pty', 'own-v2', '', 'Own'])('refuses the engine %p, which this build cannot act on', (engine) => {
    expect(reasonOf(loaded({ ...good, engine }))).toContain('engine');
  });

  it('refuses an engine that is not even a string', () => {
    expect(loaded({ ...good, engine: 7 }).kind).toBe('broken');
  });
});
