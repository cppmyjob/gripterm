import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptIndex } from '../../packages/core/src/infrastructure/transcript-index';
import type { TranscriptIndex } from '../../packages/core/src/index';

/**
 * The tree built below is the one measured on the target machine (A25,
 * 2026-08-12): conversations sit one level down as `<sessionId>.jsonl`, and
 * everything deeper belongs to subagents and workflows. The project directory
 * names here are invented -- the real ones are the encoded working directories
 * of whoever runs this, and this repository is published.
 */
const ONE = '28ab47db-c394-4d94-86e6-e98056f535f2';
const TWO = '7c9a1b2d-3e4f-4a5b-8c6d-9e0f1a2b3c4d';
const NESTED = '380656d8-4d34-4c09-8405-2b05d0db25ec';

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-transcripts-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function indexed(index: TranscriptIndex): { ids: readonly string[], skipped: number } {
  if (index.kind !== 'indexed') {
    throw new Error(`expected an index, and got ${index.reason}`);
  }
  return { ids: [...index.sessionIds].sort(), skipped: index.skipped };
}

describe('finding out which conversations were ever spoken in', () => {
  it('reads the layout the CLI actually keeps', async () => {
    const projects = join(base, 'projects');
    await mkdir(join(projects, 'D--Projects-one'), { recursive: true });
    await mkdir(join(projects, 'D--Projects-two'), { recursive: true });
    await writeFile(join(projects, 'D--Projects-one', `${ONE}.jsonl`), '{}\n');
    await writeFile(join(projects, 'D--Projects-two', `${TWO}.jsonl`), '{}\n');

    expect(indexed(await readTranscriptIndex(projects))).toStrictEqual({
      ids: [ONE, TWO].sort(),
      skipped: 0,
    });
  });

  it('leaves the subagents out, because nobody resumes one', async () => {
    // Measured shape: `<project>/<sessionId>/subagents/...` holds
    // `agent-*.jsonl` and a workflow's `journal.jsonl`. The directory there is
    // named for a session, which is exactly the trap a recursive scan falls
    // into -- so the scan is one level deep and matches on the file name.
    const projects = join(base, 'projects');
    const deep = join(projects, 'D--Projects-one', NESTED, 'subagents', 'workflows', 'wf_ec73d503');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'agent-aed7994c1265f7fc0.jsonl'), '{}\n');
    await writeFile(join(deep, 'journal.jsonl'), '{}\n');
    await writeFile(join(projects, 'D--Projects-one', `${ONE}.jsonl`), '{}\n');

    expect(indexed(await readTranscriptIndex(projects))).toStrictEqual({
      ids: [ONE],
      skipped: 0,
    });
  });

  it('ignores what is not a transcript', async () => {
    const projects = join(base, 'projects');
    await mkdir(join(projects, 'D--Projects-one'), { recursive: true });
    await writeFile(join(projects, 'D--Projects-one', `${ONE}.json`), '{}');
    await writeFile(join(projects, 'D--Projects-one', 'notes.jsonl'), '{}');
    await writeFile(join(projects, 'D--Projects-one', 'not-a-uuid.jsonl'), '{}');
    await writeFile(join(projects, 'loose.jsonl'), '{}');

    expect(indexed(await readTranscriptIndex(projects))).toStrictEqual({ ids: [], skipped: 0 });
  });

  it('reads a machine where nobody has said anything yet as empty, not as broken', async () => {
    // Measured 2026-08-10: a session with no prompt leaves no transcript and no
    // `projects/` directory at all. "No conversations" is an answer, and a
    // common one on a fresh profile.
    const index = await readTranscriptIndex(join(base, 'projects'));

    expect(indexed(index)).toStrictEqual({ ids: [], skipped: 0 });
  });

  it('refuses rather than reporting emptiness when the scan itself failed', async () => {
    const index = await readTranscriptIndex(join(base, 'projects'), () => {
      throw Object.assign(new Error('EPERM: operation not permitted, scandir'), { code: 'EPERM' });
    });

    expect(index).toStrictEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('EPERM') as string,
    });
  });

  it('loses one unreadable project directory and counts it, rather than the whole index', async () => {
    // One folder held by a synchroniser or an antivirus must not withhold every
    // other conversation on the machine: its own become invisible, which is the
    // refusing half of the answer, and the count says it happened.
    const projects = join(base, 'projects');
    await mkdir(join(projects, 'D--Projects-one'), { recursive: true });
    await mkdir(join(projects, 'D--Projects-locked'), { recursive: true });
    await writeFile(join(projects, 'D--Projects-one', `${ONE}.jsonl`), '{}\n');

    const index = await readTranscriptIndex(projects, async (path) => {
      if (path.endsWith('D--Projects-locked')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return await readdir(path, { withFileTypes: true });
    });

    expect(indexed(index)).toStrictEqual({ ids: [ONE], skipped: 1 });
  });
});
