import {
  readAgentRecording,
  recordedAgent,
} from '../../../packages/core/src/domain/agents/recorded/recorded-agent';
import type { AgentListing } from '../../../packages/core/src/index';
import type { AgentRecording } from '../../../packages/core/src/domain/agents/recorded/recorded-agent';

/**
 * The second implementation of the three observation ports, which is the whole
 * of why they are ports at all.
 *
 * **What it is NOT.** It is not a fake `claude`. Nothing here spawns anything,
 * parses anybody's standard output or knows a flag: it answers the three
 * questions the domain asks -- who is running, which conversations have
 * something behind them, which build is this -- out of a recording of a machine
 * on which they were once asked for real.
 *
 * **The one behaviour it must COPY rather than improve on.** `claude agents
 * --json` drops a session whose pid nothing is running as; measured again on
 * 2026-08-27 against `claude 2.1.245`, a planted session with pid 999999 came
 * back as `[]` while the same session on a live pid came back listed. That
 * filter is not decoration -- `livenessRule`'s first rule (`pid-listed-running`)
 * reads a pid on the roster as evidence that something is on that conversation
 * RIGHT NOW, and it can only do so because the roster has already dropped the
 * dead. A second implementation that answered with everything it was given
 * would be a better roster than the real one and would make that rule a lie.
 */

const BUILD = '2.1.245';

/** A recording as it is written down: plain JSON, nothing of ours in it. */
function recordingJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    agent: 'recorded',
    build: BUILD,
    capturedAt: '2026-08-27T09:57:00.000Z',
    running: {
      kind: 'listed',
      agents: [
        {
          sessionId: '7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
          pid: 4242,
          cwd: 'D:\\Projects\\Gripterm',
          kind: 'interactive',
          startedAt: 1786500000000,
          name: 'gripterm-capture',
          status: 'busy',
        },
      ],
      skipped: 0,
    },
    transcripts: {
      kind: 'indexed',
      sessionIds: ['7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'],
      skipped: 0,
    },
    ...overrides,
  };
}

function reading(json: unknown = recordingJson()): AgentRecording {
  const recording = readAgentRecording(json);
  if (recording === null) {
    throw new Error(`this recording could not be read: ${JSON.stringify(json)}`);
  }
  return recording;
}

/** Everything alive, which is the ordinary case for a recording replayed as it was taken. */
const everythingRuns = (): boolean => true;
const nothingRuns = (): boolean => false;

function listed(listing: AgentListing): AgentListing & { kind: 'listed' } {
  if (listing.kind !== 'listed') {
    throw new Error(`expected a listing, got: ${listing.reason}`);
  }
  return listing;
}

describe('a recording is read as a value or refused as a whole', () => {
  it('reads the three answers out of plain JSON', () => {
    const recording = reading();

    expect(recording.agent).toBe('recorded');
    expect(recording.build).toBe(BUILD);
    expect(listed(recording.running).agents).toHaveLength(1);
  });

  it('refuses a recording that is not an object at all', () => {
    expect(readAgentRecording('[]')).toBeNull();
    expect(readAgentRecording(null)).toBeNull();
    expect(readAgentRecording([recordingJson()])).toBeNull();
  });

  it('refuses a recording whose build is missing, because a comparison against an unnamed build is not one', () => {
    expect(readAgentRecording(recordingJson({ build: undefined }))).toBeNull();
  });

  it('reads an unavailable roster as unavailable rather than as an empty machine', () => {
    const recording = reading(
      recordingJson({ running: { kind: 'unavailable', reason: 'the recording says it could not ask' } })
    );

    expect(recording.running.kind).toBe('unavailable');
  });

  it('refuses an entry with no session id, because a record without one answers nothing', () => {
    expect(
      readAgentRecording(recordingJson({ running: { kind: 'listed', agents: [{ pid: 1 }], skipped: 0 } }))
    ).toBeNull();
  });
});

describe('the roster this recording implements', () => {
  it('answers with the sessions the recording holds', async () => {
    const agent = recordedAgent(reading(), everythingRuns);

    const listing = listed(await agent.roster.list());
    expect(listing.agents.map((one) => one.sessionId.value)).toStrictEqual([
      '7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    ]);
    expect(listing.agents[0]?.pid).toBe(4242);
    expect(listing.agents[0]?.cwd).toBe('D:\\Projects\\Gripterm');
    expect(listing.agents[0]?.status).toBe('busy');
  });

  it('drops a session whose pid nothing is running as, exactly as the CLI does', async () => {
    // The measured behaviour, and the reason the domain may read a listed pid
    // as evidence about NOW. Without this the same recording replayed tomorrow
    // would hold a conversation live for ever.
    const agent = recordedAgent(reading(), nothingRuns);

    expect(listed(await agent.roster.list()).agents).toStrictEqual([]);
  });

  it('counts a dropped session rather than losing it silently', async () => {
    const agent = recordedAgent(reading(), nothingRuns);

    expect(listed(await agent.roster.list()).skipped).toBe(1);
  });

  it('never turns a roster it could not read into an empty machine', async () => {
    const agent = recordedAgent(
      reading(recordingJson({ running: { kind: 'unavailable', reason: 'nobody asked' } })),
      everythingRuns
    );

    const listing = await agent.roster.list();
    expect(listing.kind).toBe('unavailable');
  });
});

describe('the transcripts this recording implements', () => {
  it('answers which conversations have something behind them', async () => {
    const agent = recordedAgent(reading(), everythingRuns);

    const index = await agent.transcripts.index();
    expect(index.kind).toBe('indexed');
    expect(index.kind === 'indexed' && index.sessionIds.has('7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe(true);
  });

  it('keeps an unreadable index distinct from an empty one', async () => {
    const agent = recordedAgent(
      reading(recordingJson({ transcripts: { kind: 'unavailable', reason: 'the recording says so' } })),
      everythingRuns
    );

    expect((await agent.transcripts.index()).kind).toBe('unavailable');
  });
});

describe('the build this recording implements', () => {
  it('reports the build the recording was taken from', async () => {
    const agent = recordedAgent(reading(), everythingRuns);

    const report = await agent.build.describe();
    expect(report.version).toBe(BUILD);
    expect(report.level).toBe('info');
    expect(report.message).toContain(BUILD);
  });

  it('says out loud that it is a recording, because a window running on one must not look like a window that asked', async () => {
    const agent = recordedAgent(reading(), everythingRuns);

    expect((await agent.build.describe()).message.toLowerCase()).toContain('recording');
  });
});
