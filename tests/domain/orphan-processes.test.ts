import {
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalId,
  confirmOrphans,
  orphanCandidates,
  type AgentListing,
  type AgentRecord,
  type OrphanCandidate,
  type OwnerLiveness,
  type TerminalEngine,
  type TerminalEntry,
} from '../../packages/core/src/index';
import { SESSION_UUID, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';

/**
 * Whose process this window may END -- the one rule in this project that does
 * something no undo of ours reaches.
 *
 * Every clause below is written from the cost of being wrong, and the two costs
 * are not the same size. A process left running is a `claude` nobody sees, which
 * O4 forbids and which a person can kill by hand; a process wrongly ended is
 * somebody's work destroyed, with no way back. So the rule is written to refuse,
 * and each refusal has a name.
 *
 * The rule is in two halves because the evidence arrives in two costs.
 * `orphanCandidates` reads what this machine has already told us -- records,
 * owner liveness, the boot -- and is free. `confirmOrphans` needs the CLI's own
 * listing, which is a process spawn of 0.56-0.70 s (A24), so it is asked only
 * about records the free half already allows.
 */

const NOW_MS = Date.parse('2026-08-17T10:00:00.000Z');
/** Two hours of uptime, so anything before 08:00 belongs to a previous life of this machine. */
const UPTIME_S = 7200;
const HEARD_AT = new Date('2026-08-17T09:59:00.000Z');
const BEFORE_BOOT = new Date('2026-08-17T07:30:00.000Z');

const US = 'window-that-is-asking';
const GONE = 'window-that-died';
const CLAUDE_PID = 4242;
const OTHER_PID = 9191;
const OTHER_SESSION = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

function observed(pid: number | null, at: Date = HEARD_AT): ObservedState {
  return ObservedState.create({
    state: 'idle',
    lastEventAt: at,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
  });
}

/** A record of the window that died: `own`, with a pid, heard from after the boot. */
function orphan(overrides: {
  readonly engine?: TerminalEngine;
  readonly owner?: OwnerRef;
  readonly pid?: number | null;
  readonly at?: Date;
  readonly id?: string;
  readonly session?: string;
  readonly history?: readonly SessionId[];
} = {}): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(overrides.id ?? TERMINAL_UUID),
    sessionId: SessionId.fromString(overrides.session ?? SESSION_UUID),
    sessionIdHistory: overrides.history ?? [],
    owner: overrides.owner ?? makeOwnerRef(GONE),
    engine: overrides.engine ?? 'own',
    observed: observed(overrides.pid === undefined ? CLAUDE_PID : overrides.pid, overrides.at),
  });
}

function liveness(...rows: readonly (readonly [string, OwnerLiveness])[]): ReadonlyMap<string, OwnerLiveness> {
  const map = new Map<string, OwnerLiveness>([[US, 'live']]);
  for (const [name, verdict] of rows) {
    map.set(name, verdict);
  }
  return map;
}

function candidates(
  entries: readonly TerminalEntry[],
  map: ReadonlyMap<string, OwnerLiveness> = liveness([GONE, 'dead'])
): readonly OrphanCandidate[] {
  return orphanCandidates({ entries, ownerLiveness: map, nowMs: NOW_MS, uptimeSeconds: UPTIME_S });
}

function agent(sessionId: string, pid: number | null): AgentRecord {
  return {
    sessionId: SessionId.fromString(sessionId),
    pid,
    cwd: null,
    kind: 'interactive',
    startedAt: null,
    name: null,
    // Measured 2026-08-17 (A43): a session with nothing said in it is listed
    // within three seconds and says `idle`, which is a third value beside the
    // `busy` of A24. Nothing here reads it; it is carried as the CLI's own word.
    status: 'idle',
  };
}

function listed(...agents: readonly AgentRecord[]): AgentListing {
  return { kind: 'listed', agents, skipped: 0 };
}

describe('the records whose process this window may end', () => {
  it('takes a record of a dead window that this build made a terminal of its own for', () => {
    const entry = orphan();

    const found = candidates([entry]);

    expect(found).toHaveLength(1);
    expect(found[0]?.entry.terminalId.value).toBe(TERMINAL_UUID);
    expect(found[0]?.pid).toBe(CLAUDE_PID);
  });

  it('leaves the terminals the editor made alone, however dead their window is', () => {
    // O5, measured in M2.16: under the editor's engine a `claude` outlives the
    // extension host on purpose, and a person's window that closed leaves a
    // conversation still working. Killing it would be this build destroying the
    // very thing it exists to keep.
    expect(candidates([orphan({ engine: 'editor' })])).toHaveLength(0);
  });

  it('leaves a record whose window is still answering', () => {
    expect(candidates([orphan()], liveness([GONE, 'live']))).toHaveLength(0);
  });

  it('leaves a record whose window is merely quiet', () => {
    // `unknown` is a window that is there and not talking -- asleep, hung, or on
    // a machine that stalled (M2.4). It is the answer that refuses.
    expect(candidates([orphan()], liveness([GONE, 'unknown']))).toHaveLength(0);
  });

  it('leaves a record whose window nothing has been established about', () => {
    expect(candidates([orphan()], liveness())).toHaveLength(0);
  });

  it('leaves this window\'s own records, because this window is live in its own map', () => {
    expect(candidates([orphan({ owner: makeOwnerRef(US) })])).toHaveLength(0);
  });

  it('leaves a record owned by something that is not a window', () => {
    // The liveness rule this stands on is a WINDOW's heartbeat (M2.4). A record
    // owned by a service is answered by nothing here, so nothing here may act
    // on it.
    const service = OwnerRef.create({
      kind: 'service',
      ownerId: OwnerId.fromString(GONE),
      editorKind: 'none',
      workspaceFolder: null,
    });

    expect(candidates([orphan({ owner: service })])).toHaveLength(0);
  });

  it('leaves a record we were never told a pid for', () => {
    expect(candidates([orphan({ pid: null })])).toHaveLength(0);
  });

  it('leaves a record last heard from before the machine booted', () => {
    // The pid in it is a number from a previous life, and Windows hands pids out
    // again aggressively. Whoever holds it today is a stranger.
    expect(candidates([orphan({ at: BEFORE_BOOT })])).toHaveLength(0);
  });

  it('takes a record whose terminal the person closed, because a process must not outlive its terminal', () => {
    const closed = makeEntry({
      terminalId: TerminalId.fromString(TERMINAL_UUID),
      owner: makeOwnerRef(GONE),
      engine: 'own',
      observed: observed(CLAUDE_PID),
      closedAt: HEARD_AT,
    });

    expect(candidates([closed])).toHaveLength(1);
  });

  it('takes every record that qualifies, not the first one', () => {
    const second = orphan({ id: '9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a', session: OTHER_SESSION, pid: OTHER_PID });

    expect(candidates([orphan(), second])).toHaveLength(2);
  });
});

describe('the machine\'s own word on whether that process is that conversation', () => {
  it('confirms a record the CLI names at the same pid', () => {
    const found = candidates([orphan()]);

    const verdict = confirmOrphans(found, listed(agent(SESSION_UUID, CLAUDE_PID)));

    expect(verdict.confirmed).toHaveLength(1);
    expect(verdict.unconfirmed).toHaveLength(0);
  });

  it('confirms a record whose conversation the CLI names under an id it used to have', () => {
    // `/clear` and `--fork-session` move the id and push the old one into the
    // history (M2.8). The process is the same process.
    const moved = orphan({ session: OTHER_SESSION, history: [SessionId.fromString(SESSION_UUID)] });

    const verdict = confirmOrphans(candidates([moved]), listed(agent(SESSION_UUID, CLAUDE_PID)));

    expect(verdict.confirmed).toHaveLength(1);
  });

  it('refuses a record the CLI names at a DIFFERENT pid', () => {
    // Somebody else brought that conversation back and it is running as another
    // process. Our number is stale, and stale is exactly when killing hits a
    // stranger.
    const verdict = confirmOrphans(candidates([orphan()]), listed(agent(SESSION_UUID, OTHER_PID)));

    expect(verdict.confirmed).toHaveLength(0);
    expect(verdict.unconfirmed).toHaveLength(1);
  });

  it('refuses a pid the CLI names for a conversation that is not this record\'s', () => {
    // A second `claude` on a reused pid. The pid matches and the session does
    // not, which is precisely the case the boot rule cannot see.
    const verdict = confirmOrphans(candidates([orphan()]), listed(agent(OTHER_SESSION, CLAUDE_PID)));

    expect(verdict.confirmed).toHaveLength(0);
    expect(verdict.unconfirmed).toHaveLength(1);
  });

  it('refuses a pid the CLI carries no number for', () => {
    expect(confirmOrphans(candidates([orphan()]), listed(agent(SESSION_UUID, null))).confirmed).toHaveLength(0);
  });

  it('refuses everything when the CLI could not be asked', () => {
    const unavailable: AgentListing = { kind: 'unavailable', reason: 'no claude on the PATH' };

    const verdict = confirmOrphans(candidates([orphan()]), unavailable);

    expect(verdict.confirmed).toHaveLength(0);
    expect(verdict.unconfirmed).toHaveLength(1);
  });

  it('refuses when the machine is running nothing at all', () => {
    expect(confirmOrphans(candidates([orphan()]), listed()).confirmed).toHaveLength(0);
  });
});
