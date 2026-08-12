import * as assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { claudeTranscriptsDirectory, readTranscriptIndex } from '../../packages/core/src/index';

/**
 * The claim no unit test can make: that on this machine, with this build of the
 * CLI, conversations are still where the restore predicate looks for them.
 *
 * The unit tests build the layout measured on 2026-08-12 (A25) in a temporary
 * directory, so they will keep passing the day an upgrade moves it. This one
 * goes red instead -- a renamed directory, a renamed file, one more level of
 * nesting, and the index comes back empty.
 *
 * READ-ONLY, and that is the whole of its contact with a person's profile: it
 * lists directory entries under `~/.claude/projects` and asserts a count. No
 * transcript is opened, no path is printed into an assertion message, nothing is
 * written. An isolated `CLAUDE_CONFIG_DIR` would defeat the purpose here --
 * planting our own file would prove that we can find our own file.
 */

suite('finding the conversations of this machine', () => {
  test('finds transcripts where the reader looks for them', async () => {
    const directory = claudeTranscriptsDirectory({
      platform: process.platform,
      home: homedir(),
      configDir: process.env.CLAUDE_CONFIG_DIR,
    });

    // Not a skip. A machine that has never held a conversation cannot make the
    // claim this test exists to make, so it says so rather than passing quietly.
    const found = await stat(directory).catch(() => null);
    assert.ok(
      found?.isDirectory() === true,
      'Claude Code has never stored a conversation on this machine, so the layout cannot be checked'
    );

    const index = await readTranscriptIndex(directory);

    assert.ok(index.kind === 'indexed', JSON.stringify(index));
    assert.ok(
      index.sessionIds.size > 0,
      `no transcript was recognised in ${index.sessionIds.size} results, though the directory exists`
    );
    for (const id of index.sessionIds) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
