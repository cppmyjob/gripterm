import type { AgentListing } from '../entities/agent-record';

/**
 * What is running on this machine right now, asked of whoever knows.
 *
 * The question is the same for every agent; the way it is answered is not, so
 * the answer comes from an implementation under `domain/agents/<name>/` and the
 * domain sees this and nothing else. Until 2026-08-27 the composition root
 * called one CLI's reader by name in three places, which made "we have a port"
 * a sentence rather than a fact.
 *
 * **THE INVARIANT, and it is the reason this port has a doc comment at all.**
 *
 *   *A record that names a pid must name one that was alive when the roster was
 *   read.*
 *
 * (A record naming no pid is left alone, and the direction of that is
 * deliberate: it cannot be shown alive, but taking it off the roster is what
 * PERMITS a restore. See `dropTheDead` in the recorded implementation.)
 *
 * It is not a nicety. `livenessRule`'s first rule reads a pid on the roster as
 * evidence about NOW -- ahead of a witnessed end, ahead of the boot clock -- and
 * that ordering is only sound because Claude Code filters its own list by
 * process liveness (measured 2026-08-12 as A24, measured again 2026-08-27
 * against `claude 2.1.245`: a planted session on pid 999999 comes back as `[]`,
 * the same session on a live pid comes back listed). An implementation that
 * answered with sessions whose processes are gone would hold every one of those
 * conversations un-restorable for ever, and nothing in the domain would say why.
 *
 * So the invariant belongs to the PORT: a second agent whose own listing does
 * not filter by liveness has to filter before answering here. That sentence is
 * the thing the plan's four-place table did not have, and it is worth more than
 * the file move.
 *
 * **A failure is a value and never an empty list.** `AgentListing` carries
 * `unavailable` for exactly this reason: silence read as permission is how a
 * live conversation gets a second `--resume` attached to it.
 */
export interface AgentRoster {
  /** Who is running right now, or why that could not be said. Never throws. */
  list: () => Promise<AgentListing>;
}
