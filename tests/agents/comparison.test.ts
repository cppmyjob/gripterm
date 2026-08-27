import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentListing } from '../../packages/core/src/domain/agents/claude-code/agent-listing';
import { parseCliVersion } from '../../packages/core/src/domain/agents/claude-code/cli-version';
import {
  readAgentRecording,
  recordedAgent,
} from '../../packages/core/src/domain/agents/recorded/recorded-agent';
import type { AgentListing, AgentRecord } from '../../packages/core/src/index';
import type { AgentRecording } from '../../packages/core/src/domain/agents/recorded/recorded-agent';

/**
 * THE COMPARISON. One scene, read two ways, and they must agree.
 *
 * **Why a fake needs one at all.** A second implementation of a port is only
 * worth having while it answers what the first one answers. Nothing stops a
 * recording from being tidied into something nicer than the machine it was taken
 * from -- and a fake that behaves better than the real thing turns green the
 * tests that are red on a person's own computer. That is worse than no fake: it
 * is a suite that reports the absence of a defect it cannot see.
 *
 * **The scene.** Three sessions planted into a `CLAUDE_CONFIG_DIR` of the run's
 * own -- one complete, one with no `name` and no `status`, one that says it
 * knows neither its directory (`"?"`) nor its start (`0`) -- and read back out
 * of the CLI. The capture in `tests/agents/fixtures/roster-scene-2026-08-27.json`
 * is that read, verbatim, against `claude 2.1.245` on 2026-08-27, and the
 * `recording` beside it is the same scene written as this build's own value.
 *
 * **What runs where, and it is the plan's rule.** This half runs ALWAYS and
 * costs nothing: no process, no profile, no turn. The other half --
 * `tests/integration/agent-listing.test.ts` -- plants the same three shapes,
 * runs the REAL CLI, and asks whether it still prints them that way and whether
 * the build is still the one the recording names. Rarely, and deliberately.
 *
 * **Order is compared as a set, and that is measured rather than conceded.** The
 * capture came back `?`-session first, complete second, nameless third -- which
 * is neither the plant order nor any sort of the fields. The CLI does not
 * promise an order, so neither does the port; what is compared is the sessions
 * and everything the domain reads off each.
 */

interface Scene {
  readonly build: string;
  readonly versionOutput: string;
  readonly printed: string;
  readonly recording: unknown;
  /** The live pids the scene was planted on, in plant order. */
  readonly pids: readonly number[];
  readonly planted: readonly { readonly sessionId: string }[];
}

const SCENE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'roster-scene-2026-08-27.json'), 'utf8')
) as Scene;

function theRecording(): AgentRecording {
  const recording = readAgentRecording(SCENE.recording);
  if (recording === null) {
    throw new Error('the recording beside the capture could not be read as one');
  }
  return recording;
}

/** Everything in the recording was alive when it was taken, which is what a replay of it means. */
const asRecorded = (): boolean => true;

function listed(listing: AgentListing): readonly AgentRecord[] {
  if (listing.kind !== 'listed') {
    throw new Error(`expected a listing, got: ${listing.reason}`);
  }
  return listing.agents;
}

/**
 * One listing as something two readings can be compared by.
 *
 * Keyed by the conversation, because the CLI's order is its own; and the pid is
 * carried as its POSITION in the plant order rather than as itself, so that the
 * other half of this comparison -- which has to plant on whatever pids the
 * machine gives it -- compares the same thing.
 */
function comparable(agents: readonly AgentRecord[], pids: readonly number[]): unknown {
  return [...agents]
    .map((agent) => ({
      sessionId: agent.sessionId.value,
      plantedAt: pids.indexOf(agent.pid ?? -1),
      cwd: agent.cwd,
      kind: agent.kind,
      startedAt: agent.startedAt,
      name: agent.name,
      status: agent.status,
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

describe('the recorded agent and the CLI it was recorded from answer the same scene', () => {
  it('names the same conversations, with the same fields, out of the same three plantings', async () => {
    const fromTheCli = listed(parseAgentListing(SCENE.printed));
    const fromTheRecording = listed(await recordedAgent(theRecording(), asRecorded).roster.list());

    expect(comparable(fromTheRecording, SCENE.pids)).toStrictEqual(
      comparable(fromTheCli, SCENE.pids)
    );
  });

  it('agrees about how many entries named no conversation', async () => {
    const fromTheCli = parseAgentListing(SCENE.printed);
    const fromTheRecording = await recordedAgent(theRecording(), asRecorded).roster.list();

    expect(fromTheRecording.kind === 'listed' && fromTheRecording.skipped).toBe(
      fromTheCli.kind === 'listed' && fromTheCli.skipped
    );
  });

  it('was recorded from the build the capture names, so the two halves are about one CLI', () => {
    expect(theRecording().build).toBe(parseCliVersion(SCENE.versionOutput));
    expect(theRecording().build).toBe(SCENE.build);
  });

  it('is a scene with all three measured shapes in it, so agreeing about it means something', () => {
    // Without this the two assertions above are satisfied by a scene of one
    // ordinary session -- the case that could never have diverged.
    const fromTheCli = listed(parseAgentListing(SCENE.printed));

    expect(fromTheCli).toHaveLength(3);
    expect(fromTheCli.filter((one) => one.name === null)).toHaveLength(1);
    expect(fromTheCli.filter((one) => one.cwd === null)).toHaveLength(1);
    expect(fromTheCli.filter((one) => one.startedAt === null)).toHaveLength(1);
    expect(SCENE.planted).toHaveLength(3);
  });
});
