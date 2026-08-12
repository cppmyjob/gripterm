import { AGENT_LISTING_ARGS, parseAgentListing } from '../domain/agents/claude-code/agent-listing';
import type { AgentListing } from '../domain/entities/agent-record';
import { type CliRun, runCli } from './cli-run';

/**
 * Room for the whole answer and nothing like room for a runaway one.
 *
 * A session costs about 250 bytes in this output (measured), so this holds
 * something on the order of four thousand of them -- three orders of magnitude
 * past a machine anyone works on. It is a bound against a program that has
 * stopped being `claude`, not against a busy day.
 */
const MAX_LISTING_BYTES = 1_048_576;

/**
 * What this machine is running, asked of the CLI itself.
 *
 * Kept to one door for the two callers who will have it -- the restore planner
 * and the reconciler -- because the rule below is the kind that gets forgotten
 * at the second call site, and forgetting it once is enough.
 */
export async function readAgentListing(
  executablePath: string,
  timeoutMs: number
): Promise<AgentListing> {
  return agentListingFrom(
    await runCli(executablePath, AGENT_LISTING_ARGS, {
      timeoutMs,
      maxOutputBytes: MAX_LISTING_BYTES,
    })
  );
}

/**
 * The rule that must not be forgotten: **a run that failed is not an idle
 * machine.**
 *
 * `catch { return [] }` is the natural shape here and it is the defect: an
 * empty list reads downstream as "no conversation is running, go ahead", and
 * going ahead means a second `claude --resume` attached to a live conversation
 * -- messages interleaved in one transcript, with nothing to take it back. So
 * the failure survives as a failure, carrying the words the platform gave it.
 */
export function agentListingFrom(run: CliRun): AgentListing {
  if (run.stdout === null) {
    return {
      kind: 'unavailable',
      reason: run.failure ?? 'the CLI was asked what is running and answered nothing',
    };
  }
  return parseAgentListing(run.stdout);
}
