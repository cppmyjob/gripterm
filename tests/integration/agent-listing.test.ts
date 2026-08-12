import * as assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findExecutable, readAgentListing } from '../../packages/core/src/index';

/**
 * The one claim about `claude agents --json` that no unit test can make: that
 * this build of the CLI, on this machine, prints what the reader was written
 * against.
 *
 * The unit tests are fed output captured on 2026-08-12 (A24). They will keep
 * passing forever, including on the day an upgrade changes the shape -- and
 * that day is not hypothetical here, because the shape comes from an internal
 * accounting format already in its fifth version (A22). This test is the thing
 * that goes red instead.
 *
 * **The session it looks for is one we plant**, in an isolated
 * `CLAUDE_CONFIG_DIR`, naming this very process as the live one. Two reasons,
 * both load-bearing: the assertion becomes exact (a session id we chose, a pid
 * we know) rather than "whatever happened to be running", and the owner's real
 * `~/.claude` is never touched -- not read for the assertion, not written to,
 * not left with a file to clean up. `procStart` is deliberately omitted: it is
 * optional (measured), and fabricating a process start time would be the one
 * field in this file we could get wrong without noticing.
 */

const PLANTED_SESSION = '7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CLAUDE = 'claude';
const GENEROUS_MS = 20_000;

function plantedRecord(): string {
  return JSON.stringify({
    pid: process.pid,
    sessionId: PLANTED_SESSION,
    cwd: 'D:\\Projects\\Gripterm',
    startedAt: 1786500000000,
    version: '2.1.228',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'gripterm-integration',
    status: 'busy',
  });
}

suite('reading what this machine is running', () => {
  test('reads a real listing out of the real CLI', async () => {
    const claude = await findExecutable(CLAUDE, {
      path: process.env.PATH,
      pathExt: process.env.PATHEXT,
      platform: process.platform,
    });
    // Not a skip. This extension exists to run Claude Code, and a machine
    // without it cannot make the claim this test is here to make -- so it says
    // so rather than passing quietly.
    assert.ok(claude !== null, 'Claude Code is not on the PATH this test inherited');

    const configDir = join(tmpdir(), `gripterm-agents-${process.pid}`);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    await mkdir(join(configDir, 'sessions'), { recursive: true });
    await writeFile(join(configDir, 'sessions', `${process.pid}.json`), plantedRecord(), 'utf8');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    try {
      const listing = await readAgentListing(claude, GENEROUS_MS);

      assert.ok(listing.kind === 'listed', JSON.stringify(listing));
      const planted = listing.agents.find((agent) => agent.sessionId.value === PLANTED_SESSION);
      assert.ok(planted, `planted session missing from ${JSON.stringify(listing.agents)}`);
      assert.equal(planted.pid, process.pid);
      assert.equal(planted.kind, 'interactive');
      assert.equal(planted.name, 'gripterm-integration');
      assert.equal(planted.status, 'busy');
      assert.equal(planted.startedAt, 1786500000000);
      assert.equal(planted.cwd, 'D:\\Projects\\Gripterm');
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
