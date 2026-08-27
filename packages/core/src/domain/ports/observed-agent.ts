import type { AgentBuild } from './agent-build';
import type { AgentRoster } from './agent-roster';
import type { ConversationTranscripts } from './conversation-transcripts';

/**
 * The three questions a window asks about an agent it did not start, in one
 * object the composition root picks ONCE.
 *
 * Bundled rather than passed as three arguments because they are three answers
 * about the same installation and must not be mixed between two: a roster read
 * from one agent beside a transcript index read from another produces
 * `no-transcript` for conversations that are perfectly resumable, and the
 * product's answer to `no-transcript` is a NEW conversation in the same record.
 * That is a person's history quietly replaced, and no undo of ours reaches it.
 *
 * The launch side is deliberately not here: `AgentCommandFactory` is a port of
 * its own, is built from an address and a token this object knows nothing about,
 * and is chosen at a different moment.
 */
export interface ObservedAgent {
  /**
   * What to call this agent to a person.
   *
   * The way out of `HUMAN_TEXTS` in `tests/agent-vocabulary.test.ts`, named
   * there since 2026-08-24: the display name belongs to the implementation of a
   * port and not to the domain. Nothing interpolates it yet, and saying so here
   * is better than a field that looks used.
   */
  readonly name: string;
  readonly roster: AgentRoster;
  readonly transcripts: ConversationTranscripts;
  readonly build: AgentBuild;
}
