import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readSessionName } from '../domain/agents/claude-code/session-name';
import type { SessionId } from '../domain/entities/session-id';

/**
 * The name Claude Code has for a conversation, out of its own session file.
 *
 * The file is named after the pid of the process holding the conversation, and
 * that pid is the one the editor gave us when it started the terminal (M2.16).
 * Which means this needs nothing from the CLI's cooperation -- no hook, no flag,
 * no forwarder -- and works for a terminal whose hooks never arrived.
 *
 * NOTHING THROWS, and every failure is the same `null`: a missing directory on a
 * machine where the CLI has never run, a file deleted between the read and the
 * open, a half-written one caught mid-flush. This is called on a timer with
 * nobody waiting for it, so there is no one to report a failure TO -- the honest
 * answer to all of it is "we cannot say what the CLI calls this", and the caller
 * then leaves the row's name where it is.
 */
export async function readClaudeSessionName(
  sessionsDir: string,
  pid: number,
  conversation: SessionId
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(sessionsDir, `${pid.toString()}.json`), 'utf8');
  } catch {
    return null;
  }
  return readSessionName(text, conversation);
}
