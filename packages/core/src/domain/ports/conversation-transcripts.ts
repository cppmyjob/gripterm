import type { TranscriptIndex } from '../entities/transcript-index';

/**
 * Which conversations have something behind them, asked of whoever keeps them.
 *
 * The restore predicate cannot get this from the roster: a conversation nobody
 * ever spoke in is not running and has nothing to continue, and the two are
 * different answers. Claude Code keeps transcripts in a directory of its own
 * whose naming is undocumented, so the implementation scans and matches on the
 * file NAME (`readTranscriptIndex`); another agent may answer the same question
 * from a database, a socket, or not at all.
 *
 * **A scan that failed must never arrive as an empty index**, which is what
 * `TranscriptIndex` is a union for: empty means "nothing has ever been said in
 * these conversations", a legitimate and common answer, and failure means we do
 * not know.
 */
export interface ConversationTranscripts {
  /** Which conversations have a transcript, or why that could not be said. Never throws. */
  index: () => Promise<TranscriptIndex>;
}
