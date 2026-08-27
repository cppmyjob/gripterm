import { describeCliVersion } from '../../domain/agents/claude-code/cli-version';
import { probeVersionOutput } from '../cli-probe';
import { readAgentListing } from '../cli-agents';
import { readTranscriptIndex } from '../transcript-index';
import type { AgentBuild, AgentBuildReport } from '../../domain/ports/agent-build';
import type { AgentListing } from '../../domain/entities/agent-record';
import type { AgentRoster } from '../../domain/ports/agent-roster';
import type { ConversationTranscripts } from '../../domain/ports/conversation-transcripts';
import type { ObservedAgent } from '../../domain/ports/observed-agent';
import type { TranscriptIndex } from '../../domain/entities/transcript-index';

/**
 * Claude Code as ONE implementation of the three observation ports.
 *
 * **Where agent-specific INFRASTRUCTURE lives, answered rather than left open.**
 * `domain/agents/<name>/` has been the one place allowed to know whose CLI it is
 * since 2026-08-24 -- but only for pure rules, because the domain may not touch
 * a disk or a process. Everything that does has been sitting in
 * `infrastructure/` unmarked beside code that belongs to no agent at all:
 * `cli-agents.ts`, `transcript-index.ts`, `cli-probe.ts`,
 * `store/claude-settings-reader.ts`, `claude-session-name.ts`. The plan (Ш4б)
 * named that as the open question of the transcript place. This directory is the
 * answer: `infrastructure/agents/<name>/` mirrors `domain/agents/<name>/`, and
 * what stands directly in `infrastructure/` is what a second agent would reuse.
 *
 * **Nothing here is new behaviour.** The three functions below are the same
 * three the composition root called by name until 2026-08-27, with the same
 * arguments, in the same order. What has changed is that they are now reachable
 * through a type a second implementation also satisfies -- see
 * `domain/agents/recorded/recorded-agent.ts`, which is the one that makes the
 * word "port" true.
 *
 * **The invariant of `AgentRoster` is satisfied by the CLI itself**, and that is
 * why the reader below does not filter: `claude agents --json` does not print a
 * session whose pid nothing is running as. Measured 2026-08-12 (A24) and again
 * 2026-08-27 against 2.1.245 -- the same planted session listed on a live pid,
 * `[]` on pid 999999.
 */

/** What this agent is called to a person. The domain no longer has to know. */
export const CLAUDE_CODE = 'Claude Code';

/**
 * Where the CLI is, or the sentence saying why this window cannot ask it.
 *
 * A union rather than a nullable path, so that the refusal REACHES the answers:
 * a window with no CLI on its PATH must say "I could not ask" and never "nothing
 * is running", and a nullable path pushes that decision to whoever remembers.
 */
export type CliLocation =
  | { readonly kind: 'ready', readonly path: string }
  | { readonly kind: 'refused', readonly reason: string };

export interface ClaudeCodeAgentParams {
  readonly cli: CliLocation;
  /** The CLI's own transcripts directory, worked out by `claudeTranscriptsDirectory`. */
  readonly transcriptsDir: string;
  readonly listingTimeoutMs: number;
  readonly versionTimeoutMs: number;
}

export function claudeCodeAgent(params: ClaudeCodeAgentParams): ObservedAgent {
  return {
    name: CLAUDE_CODE,
    roster: new CliRoster(params),
    transcripts: new DirectoryTranscripts(params.transcriptsDir),
    build: new CliBuild(params),
  };
}

class CliRoster implements AgentRoster {
  private readonly _params: ClaudeCodeAgentParams;

  constructor(params: ClaudeCodeAgentParams) {
    this._params = params;
  }

  public async list(): Promise<AgentListing> {
    const { cli, listingTimeoutMs } = this._params;
    if (cli.kind === 'refused') {
      return { kind: 'unavailable', reason: cli.reason };
    }
    return await readAgentListing(cli.path, listingTimeoutMs);
  }
}

class DirectoryTranscripts implements ConversationTranscripts {
  private readonly _projectsDir: string;

  constructor(projectsDir: string) {
    this._projectsDir = projectsDir;
  }

  public async index(): Promise<TranscriptIndex> {
    return await readTranscriptIndex(this._projectsDir);
  }
}

class CliBuild implements AgentBuild {
  private readonly _params: ClaudeCodeAgentParams;

  constructor(params: ClaudeCodeAgentParams) {
    this._params = params;
  }

  public async describe(): Promise<AgentBuildReport> {
    const { cli, versionTimeoutMs } = this._params;
    if (cli.kind === 'refused') {
      // Not a mismatch and not a version: a build we could not ask about. Saying
      // anything else would send somebody to reinstall something that is fine.
      return describeCliVersion({ output: null, failure: cli.reason });
    }
    return describeCliVersion(await probeVersionOutput(cli.path, versionTimeoutMs));
  }
}
