import { join } from 'node:path';
import { agentListingFrom, readAgentListing } from '../../packages/core/src/infrastructure/cli-agents';

const GENEROUS_MS = 10_000;

describe('turning what the CLI said into what is running', () => {
  it('reads a listing when there was one', async () => {
    const listing = agentListingFrom({ stdout: '[]', failure: null });

    expect(listing).toStrictEqual({ kind: 'listed', agents: [], skipped: 0 });
  });

  it('keeps the reason a run failed, instead of reporting an idle machine', async () => {
    // The whole point of the two-member union, met at the seam where the
    // temptation lives: `catch { return [] }` here would tell the restore path
    // that nothing is running whenever the CLI could not be asked.
    const listing = agentListingFrom({ stdout: null, failure: 'spawn claude ENOENT' });

    expect(listing).toStrictEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('spawn claude ENOENT') as string,
    });
  });

  it('still refuses when the failure came with no words', async () => {
    const listing = agentListingFrom({ stdout: null, failure: null });

    expect(listing.kind).toBe('unavailable');
  });
});

describe('asking this machine what it is running', () => {
  it('reports a missing CLI as an unavailable listing and not as an empty one', async () => {
    const listing = await readAgentListing(join(__dirname, 'no-such-claude.exe'), GENEROUS_MS);

    expect(listing).toMatchObject({ kind: 'unavailable' });
  });
});
