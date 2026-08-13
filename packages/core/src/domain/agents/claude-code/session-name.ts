import type { SessionId } from '../../entities/session-id';

/**
 * The key the CLI writes when IT invented the name.
 *
 * Measured on 2026-08-13 against 2.1.228: a fresh session's file carries
 * `"nameSource":"derived"`, and `/rename` writes the new name and REMOVES the
 * key. So the absence of this field is the whole of the evidence that a person
 * typed the name -- there is no positive marker to look for.
 */
const DERIVED_MARKER = 'nameSource';

/**
 * The name Claude Code has for a conversation, when a person is the one who gave
 * it -- and `null` in every other case.
 *
 * The input is one file out of `~/.claude/sessions/`, named after the pid of the
 * process holding the conversation. A22 refused that directory as a SOURCE of
 * sessions and permitted exactly this: a name, as a hint, under a guard. The
 * guard here is the conversation id, which is stronger than the pid+start+cwd
 * triple that milestone proposed -- a file left behind by a dead process whose
 * pid has been reused names a different conversation, and is refused by the one
 * comparison below.
 *
 * NOTHING THROWS. This is read on a timer, in every window, from a directory
 * belonging to another program: half-written JSON, a schema that moved and a
 * file that vanished between the listing and the read are ordinary sights. Every
 * one of them means the same thing to the caller -- leave the row's name alone.
 *
 * A DERIVED NAME IS REFUSED, and that is the point of the function. The CLI
 * names a fresh conversation after its folder (`trudocker-50`), and putting that
 * on the row would replace a name this build chose for the person -- and chose
 * to be unique within the window -- with one that is neither.
 */
export function readSessionName(text: string, conversation: SessionId): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const fields = payload as Record<string, unknown>;
  if (fields.sessionId !== conversation.value) {
    return null;
  }
  // Present at all, with any value: a source this build has never met is not
  // evidence of a person, and `null` is a value the CLI could start writing
  // tomorrow.
  if (fields[DERIVED_MARKER] !== undefined) {
    return null;
  }

  const name = fields.name;
  if (typeof name !== 'string') {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}
