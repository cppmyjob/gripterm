import type { SessionId } from '../../entities/session-id';

/**
 * The key the CLI writes to say where the name came from.
 *
 * TWO MEASUREMENTS, AND THE RULE BELOW IS THE DIFFERENCE BETWEEN THEM. Both are
 * kept: this build runs against whatever CLI the machine has.
 *
 * 2026-08-13, against 2.1.228: a fresh session's file carried
 * `"nameSource":"derived"`, and `/rename` wrote the new name and REMOVED the
 * key. The absence of the field was the whole of the evidence that a person had
 * typed the name, and there was no positive marker to look for.
 *
 * 2026-09-08, on the owner's machine, against 2.1.260: the key is present in
 * every one of four live sessions -- `"derived"` in two, `"user"` in the other
 * two. There IS a positive marker now, and `/rename` no longer takes the key
 * away. That is what turned the old rule, written to ADMIT a person's name, into
 * one that refused every name the CLI writes: the owner typed `/rename fdfd`,
 * the CLI renamed the conversation, and the row did not move.
 *
 * Neither measurement contradicts the other, so one rule serves both builds:
 * `"user"` is a person, an absent key was a person on 2.1.228, and anything else
 * -- including a source this build has never met -- is not.
 */
const NAME_SOURCE = 'nameSource';

/**
 * The one value of that key which says a person chose the name.
 *
 * WHAT WAS MEASURED on 2026-09-08 against 2.1.260: two of four live session
 * files carried this value, the other two carried `derived`, and none was
 * without the key. WHAT WAS NOT: which conversation each file belonged to, and
 * what the CLI writes for a session started with `--name` -- which this product
 * passes on every launch and every resume. `derived` there would mean the name
 * is refused at launch and the two sides part company until somebody types
 * `/rename`; `user` there would mean this build follows back the very name it
 * gave, which costs nothing. Both are guesses until somebody looks.
 */
const CHOSEN_BY_A_PERSON = 'user';

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
 *
 * HOW a person's name is recognised depends on the build of the CLI, and both
 * ways are accepted -- see `NAME_SOURCE`. What is refused has not changed.
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
  // Absent (2.1.228 and older) or `user` (2.1.260): a person. Anything else --
  // `derived`, a source this build has never met, and `null`, which is a value
  // the CLI could start writing tomorrow -- is not evidence of one.
  const source = fields[NAME_SOURCE];
  if (source !== undefined && source !== CHOSEN_BY_A_PERSON) {
    return null;
  }

  const name = fields.name;
  if (typeof name !== 'string') {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The line to type into a conversation to give it the name its row now has.
 *
 * There is no other way round: the CLI takes a name at startup (`--name`) and
 * from `/rename`, and offers nothing an outsider can call. The state file that
 * `[jobStateNameSync]` watches -- `<config>/jobs/<short>/state.json` -- is for
 * background jobs, and a machine running only interactive sessions has no such
 * directory at all (measured 2026-08-13).
 *
 * **Whitespace is collapsed, and that is the whole of the safety here.** This
 * string is typed into a terminal and the newline after it SENDS it: a name
 * carrying a line break would rename the conversation to half of itself and
 * submit the other half as a message -- a turn spent, and a line nobody wrote in
 * somebody's transcript.
 */
export function claudeRenameCommand(name: string): string {
  return `/rename ${name.replace(/\s+/gu, ' ').trim()}`;
}
