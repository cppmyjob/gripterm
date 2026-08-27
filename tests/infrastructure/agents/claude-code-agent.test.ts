import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CLAUDE_CODE,
  claudeCodeAgent,
} from '../../../packages/core/src/infrastructure/agents/claude-code-agent';

/**
 * Claude Code as ONE of the implementations of the three observation ports.
 *
 * Nothing here is new behaviour, and that is the claim being made: the reader of
 * `agents --json`, the scan of the transcripts directory and the version probe
 * are the same three functions the composition root called by name until
 * 2026-08-27. What changed is that it now picks an `ObservedAgent` once instead
 * of naming those three at five call sites -- which is what makes a second agent
 * a choice rather than a rewrite.
 *
 * **What this suite can and cannot ask.** It cannot ask what the real CLI
 * prints; that is `tests/integration/agent-listing.test.ts`, which spends a
 * process on purpose. What it asks is the half that has always been the
 * dangerous one: that a window which CANNOT ask says so, in every one of the
 * three answers, and never says "nothing is running".
 */

const GENEROUS_MS = 20_000;

async function temporary(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'gripterm-agent-'));
}

describe('a window that cannot ask the CLI at all', () => {
  it('answers the roster with the refusal, and never with an empty machine', async () => {
    const agent = claudeCodeAgent({
      cli: { kind: 'refused', reason: 'Gripterm cannot find claude on this machine.' },
      transcriptsDir: await temporary(),
      listingTimeoutMs: GENEROUS_MS,
      versionTimeoutMs: GENEROUS_MS,
    });

    const listing = await agent.roster.list();
    expect(listing.kind).toBe('unavailable');
    expect(listing.kind === 'unavailable' && listing.reason).toContain('cannot find');
  });

  it('answers the build with a warning and no version, rather than claiming a mismatch nobody established', async () => {
    const agent = claudeCodeAgent({
      cli: { kind: 'refused', reason: 'Gripterm cannot find claude on this machine.' },
      transcriptsDir: await temporary(),
      listingTimeoutMs: GENEROUS_MS,
      versionTimeoutMs: GENEROUS_MS,
    });

    const report = await agent.build.describe();
    expect(report.version).toBeNull();
    expect(report.level).toBe('warn');
  });

  it('still reads the transcripts, because they are on the disk and need no CLI', async () => {
    const projects = await temporary();
    const oneProject = join(projects, 'D--Projects-Gripterm');
    await mkdir(oneProject, { recursive: true });
    await writeFile(join(oneProject, '7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d.jsonl'), '{}\n', 'utf8');

    const agent = claudeCodeAgent({
      cli: { kind: 'refused', reason: 'no CLI' },
      transcriptsDir: projects,
      listingTimeoutMs: GENEROUS_MS,
      versionTimeoutMs: GENEROUS_MS,
    });

    const index = await agent.transcripts.index();
    expect(index.kind).toBe('indexed');
    expect(index.kind === 'indexed' && index.sessionIds.has('7c9a1b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe(true);
    await rm(projects, { recursive: true, force: true });
  });
});

describe('a window whose CLI is not where it was said to be', () => {
  it('brings the failure back as a value, in every answer that needs the CLI', async () => {
    const agent = claudeCodeAgent({
      cli: { kind: 'ready', path: join(__dirname, 'no-such-claude.exe') },
      transcriptsDir: await temporary(),
      listingTimeoutMs: GENEROUS_MS,
      versionTimeoutMs: GENEROUS_MS,
    });

    const listing = await agent.roster.list();
    expect(listing.kind).toBe('unavailable');
    const report = await agent.build.describe();
    expect(report.version).toBeNull();
    expect(report.level).toBe('warn');
  });
});

describe('the agent names itself', () => {
  it('carries the name a person reads, so that the domain does not have to', async () => {
    const agent = claudeCodeAgent({
      cli: { kind: 'refused', reason: 'no CLI' },
      transcriptsDir: await temporary(),
      listingTimeoutMs: GENEROUS_MS,
      versionTimeoutMs: GENEROUS_MS,
    });

    expect(agent.name).toBe(CLAUDE_CODE);
    expect(CLAUDE_CODE).toBe('Claude Code');
  });
});
