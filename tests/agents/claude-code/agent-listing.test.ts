import {
  AGENT_LISTING_ARGS,
  parseAgentListing,
} from '../../../packages/core/src/domain/agents/claude-code/agent-listing';
import type { AgentListing, AgentRecord } from '../../../packages/core/src/index';

/**
 * Every case here is a shape the CLI was MEASURED to print, not one it might
 * print: `docs/experiments/2026-08-12-a24-agents-json.md`, `claude 2.1.228`.
 *
 * The values are neutral on purpose -- the verbatim capture names the owner's
 * other projects, and this file is in the repository that gets published.
 */
const REAL_OUTPUT = `[
  {
    "pid": 17528,
    "cwd": "D:\\\\Projects\\\\Gripterm",
    "kind": "interactive",
    "startedAt": 1786529751750,
    "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e",
    "name": "gripterm-df",
    "status": "busy"
  },
  {
    "pid": 13988,
    "cwd": "D:\\\\Projects\\\\Other",
    "kind": "interactive",
    "startedAt": 1786524362436,
    "sessionId": "daa9b06d-0e5a-4295-9c60-65519b30b3ad",
    "name": "OTHER_WORK",
    "status": "busy"
  }
]
`;

function listed(listing: AgentListing): readonly AgentRecord[] {
  if (listing.kind !== 'listed') {
    throw new Error(`expected a listing, got: ${listing.reason}`);
  }
  return listing.agents;
}

function one(text: string): AgentRecord {
  const agents = listed(parseAgentListing(text));
  expect(agents).toHaveLength(1);
  return agents[0] as AgentRecord;
}

describe('the question we ask the CLI', () => {
  it('asks for the running sessions, and does not ask for the finished ones', () => {
    // `--all` is what the plan named, and the binary's own help says what it
    // adds: "also include completed background sessions". A completed session
    // cannot be a live conversation, but its `sessionId` can equal one of ours
    // -- and then it would forbid a restore that is perfectly legal.
    expect([...AGENT_LISTING_ARGS]).toStrictEqual(['agents', '--json']);
  });
});

describe('reading what `claude agents --json` prints', () => {
  it('reads the shape the CLI actually prints', () => {
    const agents = listed(parseAgentListing(REAL_OUTPUT));

    expect(agents).toHaveLength(2);
    expect(agents[0]?.sessionId.value).toBe('9221f8a4-625b-4826-8d67-bc870b4cc95e');
    expect(agents[0]?.pid).toBe(17528);
    expect(agents[0]?.cwd).toBe('D:\\Projects\\Gripterm');
    expect(agents[0]?.kind).toBe('interactive');
    expect(agents[0]?.startedAt).toBe(1786529751750);
    expect(agents[0]?.name).toBe('gripterm-df');
    expect(agents[0]?.status).toBe('busy');
    expect(agents[1]?.sessionId.value).toBe('daa9b06d-0e5a-4295-9c60-65519b30b3ad');
  });

  it('reads an empty machine as an empty list and not as a failure', () => {
    // Measured: `[]` with exit 0 is what a machine with no running session
    // says. It is an answer, and a caller must be able to tell it from silence.
    const listing = parseAgentListing('[]\n');

    expect(listing).toStrictEqual({ kind: 'listed', agents: [], skipped: 0 });
  });
});

describe('the fields the CLI omits, and the two it fills with a placeholder', () => {
  it('keeps a record that carries nothing but its session id', () => {
    // Measured: a session whose file has no name and no status is printed
    // without those keys at all.
    const record = one('[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e" }]');

    expect(record.pid).toBeNull();
    expect(record.cwd).toBeNull();
    expect(record.kind).toBeNull();
    expect(record.startedAt).toBeNull();
    expect(record.name).toBeNull();
    expect(record.status).toBeNull();
  });

  it('reads "?" as an unknown directory, because that is what it means', () => {
    // Measured: a session file without `cwd` comes back as `"cwd": "?"`. Passed
    // through, it would be shown to a person as a folder and compared with real
    // ones as a path.
    const record = one(
      '[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "cwd": "?" }]'
    );

    expect(record.cwd).toBeNull();
  });

  it('reads a zero start time as unknown rather than as 1970', () => {
    // Measured: a session file without `startedAt` comes back as `0`.
    const record = one(
      '[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "startedAt": 0 }]'
    );

    expect(record.startedAt).toBeNull();
  });

  it.each([
    ['a negative start time', '-1'],
    ['a start time that is not a number', '"yesterday"'],
    ['a start time that is not finite', '1e999'],
  ])('reads %s as unknown', (_case: string, raw: string) => {
    const record = one(
      `[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "startedAt": ${raw} }]`
    );

    expect(record.startedAt).toBeNull();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-4'],
    ['fractional', '17528.5'],
    ['spelled as a string', '"17528"'],
  ])('reads a pid that is %s as no pid at all', (_case: string, raw: string) => {
    // The rule and its reason are M2.4's, met from the reading side: `kill(0, 0)`
    // signals a process GROUP and never throws, so a zero read as a pid is a
    // process that is alive forever -- and a session that is alive forever is a
    // record that can never be restored.
    const record = one(
      `[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "pid": ${raw} }]`
    );

    expect(record.pid).toBeNull();
  });

  it('reads a blank name as no name, rather than as a name made of spaces', () => {
    // A name is put in front of a person and a status is compared; neither can
    // be a run of spaces. This is the same rule the hook parser holds for
    // identifiers, and it is here because the field it guards is the one the
    // CLI derives from a directory it may not have.
    const record = one(
      '[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "name": "   ", "status": "" }]'
    );

    expect(record.name).toBeNull();
    expect(record.status).toBeNull();
  });

  it('ignores fields this build has never heard of', () => {
    // The CLI projects a fixed set of keys today (an unknown key put into a
    // session file did NOT reach the output), so a new key means a new CLI --
    // and a new key must not cost the record it arrives with.
    const record = one(
      '[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "effort": "high" }]'
    );

    expect(record.sessionId.value).toBe('9221f8a4-625b-4826-8d67-bc870b4cc95e');
  });

  it('keeps the status and the kind as the CLI spelled them', () => {
    // Not narrowed to a union: `busy` is the only status this machine ever
    // showed, and the documented `waiting` was never observed. A set assembled
    // from documentation is a promise nobody measured.
    const record = one(
      '[{ "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e", "status": "waiting", "kind": "background" }]'
    );

    expect(record.status).toBe('waiting');
    expect(record.kind).toBe('background');
  });
});

describe('entries that name no conversation', () => {
  it('skips a record with no session id, and says how many it skipped', () => {
    // Measured, and this is why it is a skip rather than a refusal: a session
    // file without `sessionId` is printed WITHOUT the key, so an entry we
    // cannot name is an ordinary sight and not a sign the schema moved.
    const listing = parseAgentListing(
      '[{ "pid": 17528, "cwd": "D:\\\\x", "kind": "interactive" },' +
        ' { "sessionId": "9221f8a4-625b-4826-8d67-bc870b4cc95e" }]'
    );

    expect(listed(listing)).toHaveLength(1);
    expect(listing).toMatchObject({ skipped: 1 });
  });

  it('skips a session id that is not a uuid rather than throwing', () => {
    // Measured: `sessionId` is not validated by the CLI -- `not-a-uuid` reached
    // the output verbatim. It cannot equal any id we minted, so it is nothing
    // to us; what it must not be is an exception on the restore path.
    const listing = parseAgentListing('[{ "sessionId": "not-a-uuid" }]');

    expect(listed(listing)).toStrictEqual([]);
    expect(listing).toMatchObject({ skipped: 1 });
  });

  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a nested array', '[]'],
    ['a string', '"agent"'],
  ])('skips an entry that is %s', (_case: string, raw: string) => {
    const listing = parseAgentListing(`[${raw}]`);

    expect(listed(listing)).toStrictEqual([]);
    expect(listing).toMatchObject({ skipped: 1 });
  });
});

describe('output that is not a listing at all', () => {
  it('refuses text that is not JSON, and never calls it an empty machine', () => {
    // The whole point of the union: "we could not ask" must not arrive as "no
    // sessions are running", because the second one reads as permission to
    // start a second `--resume` on a live conversation.
    const listing = parseAgentListing('claude: command not found');

    expect(listing).toStrictEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('not JSON') as string,
    });
  });

  it('refuses JSON that is not an array', () => {
    const listing = parseAgentListing('{ "agents": [] }');

    expect(listing).toStrictEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('not a JSON array') as string,
    });
  });

  it('refuses empty output, and says that is what it was', () => {
    // A program that printed nothing at all answered nothing at all -- and the
    // reason has to say so, because "not JSON" with an empty quotation reads
    // like a bug in the reader rather than silence from the CLI.
    expect(parseAgentListing('   ')).toStrictEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('printed nothing') as string,
    });
  });

  it('quotes enough of the output to recognise it, and no more', () => {
    // This reason reaches the log, and what it quotes is another program's
    // standard output -- which on a bad day is a megabyte of something. A log
    // line nobody can read is the same as no log line.
    const listing = parseAgentListing(`update available!\n${'y'.repeat(5000)}`);

    expect(listing).toMatchObject({ kind: 'unavailable' });
    const { reason } = listing as { reason: string };
    expect(reason).toContain('update available!');
    expect(reason).toContain('...');
    expect(reason.length).toBeLessThan(200);
  });
});
