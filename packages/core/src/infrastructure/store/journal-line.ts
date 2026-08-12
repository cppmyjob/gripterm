import { asFiniteNumber, asRecord, asString } from '../../domain/json/json-readers';
import type { HookDelivery } from '../../domain/entities/hook-delivery';

/**
 * The schema a line was written under, stamped per LINE rather than per file.
 *
 * A journal is append-only by construction, so one file outlives several shapes:
 * the version cannot live in a header, because the header would be written
 * before the change and read after it.
 *
 * Version 1 is M1's line -- `{v, at, terminalId, raw}`, no counter, body always
 * verbatim. It is still on disk on this machine and is still read.
 */
export const JOURNAL_LINE_VERSION = 2;

/**
 * The keys kept when content is being withheld, and nothing else is.
 *
 * An ALLOWLIST, not a list of things to strip, and the difference is the whole
 * point: Claude Code adds fields between builds, and a denylist would leak every
 * new one until somebody noticed. Here a field nobody has taught this build
 * about is dropped and its NAME is recorded, so the loss is visible and the
 * content is not.
 *
 * Paths (`cwd`, `transcript_path`) are structural rather than content: the same
 * paths are already in `record.json`, and the setting this serves is about the
 * texts of prompts, answers and tool arguments (§4.8).
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'hook_event_name',
  'session_id',
  'prompt_id',
  'cwd',
  'transcript_path',
  'source',
  'reason',
  'tool_name',
  'tool_use_id',
  'permission_level',
  'notification_type',
  'error_type',
  'old_cwd',
  'new_cwd',
]);

/**
 * One line, as a reader gets it back.
 *
 * `payload` is what a hook parser can be handed: the body when it was kept
 * verbatim, or the structural fields that survived redaction. That the two
 * converge here is the reason redaction keeps the names the parser reads -- a
 * journal written with content off is still a journal the projector can replay,
 * minus the texts.
 */
export interface JournalLine {
  /** `null` for a version 1 line, which had no counter at all. */
  readonly seq: number | null;
  readonly at: Date;
  readonly terminalId: string;
  readonly payload: unknown;
  /** The body byte for byte, when the policy kept it. */
  readonly raw: string | null;
  /** Names of the fields redaction removed. Names only -- that is the point. */
  readonly dropped: readonly string[];
}

export type JournalLineDecode =
  | { readonly kind: 'line', readonly line: JournalLine }
  | { readonly kind: 'unreadable', readonly reason: string };

export interface EncodeJournalLineParams {
  readonly seq: number;
  readonly delivery: HookDelivery;
  /** §4.8's `gripterm.journal.includeContent`, which is OFF by default. */
  readonly includeContent: boolean;
}

/**
 * One delivery as one line of NDJSON, without its newline.
 *
 * `JSON.stringify` escapes every newline inside the body, so one delivery is one
 * line however many line breaks the payload contains -- the NDJSON invariant,
 * and the reason the body is a STRING field rather than embedded JSON when it is
 * kept whole: a payload we cannot parse is the payload most worth having, since
 * it is the one whose contract changed under us.
 */
export function encodeJournalLine(params: EncodeJournalLineParams): string {
  const head = {
    v: JOURNAL_LINE_VERSION,
    seq: params.seq,
    at: params.delivery.receivedAt.toISOString(),
    terminalId: params.delivery.terminalId.value,
  };
  return JSON.stringify(
    params.includeContent
      ? { ...head, raw: params.delivery.raw }
      : { ...head, ...redact(params.delivery.raw) }
  );
}

type Redaction =
  | { readonly body: Readonly<Record<string, unknown>>, readonly dropped: readonly string[] }
  /** A body that could not be redacted, so none of it was kept. The number is its length. */
  | { readonly withheld: number };

function redact(raw: string): Redaction {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { withheld: raw.length };
  }

  const record = asRecord(payload);
  if (record === null) {
    // A body that is not an object cannot be filtered field by field, and
    // keeping it whole is exactly what the policy refuses.
    return { withheld: raw.length };
  }

  const body: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    // The value has to be a scalar as well as the key structural: an object
    // parked under a name we allow would carry content straight through the
    // filter, and `tool_input` is an object.
    if (STRUCTURAL_KEYS.has(key) && isScalar(value)) {
      body[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { body, dropped };
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * One line back, or a sentence saying why not.
 *
 * Never throws, and refuses rather than guesses: a line whose `at` or
 * `terminalId` is missing is not a line this build can place in a history, and a
 * reader that accepted it would be inventing a time.
 */
export function decodeJournalLine(text: string): JournalLineDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: unknown) {
    return { kind: 'unreadable', reason: String(cause) };
  }

  const line = asRecord(parsed);
  if (line === null) {
    return { kind: 'unreadable', reason: 'a journal line must be a JSON object' };
  }

  const at = asString(line.at);
  const terminalId = asString(line.terminalId);
  if (at === null || terminalId === null) {
    return { kind: 'unreadable', reason: 'a journal line must carry at and terminalId' };
  }
  const moment = new Date(at);
  if (Number.isNaN(moment.getTime())) {
    return { kind: 'unreadable', reason: `at is not a moment: ${at}` };
  }

  const raw = asString(line.raw);
  return {
    kind: 'line',
    line: {
      seq: asFiniteNumber(line.seq),
      at: moment,
      terminalId,
      payload: payloadOf(raw, line.body),
      raw,
      dropped: droppedOf(line.dropped),
    },
  };
}

/**
 * What a parser can be handed.
 *
 * `null` when there is nothing readable: a body withheld by the policy, or one
 * that was never JSON. Both are honest answers, and both make a hook parser
 * report the line as malformed rather than pretend it understood it.
 */
function payloadOf(raw: string | null, body: unknown): unknown {
  if (raw === null) {
    return asRecord(body);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function droppedOf(value: unknown): readonly string[] {
  const names = Array.isArray(value) ? value : [];
  return names.filter((name): name is string => typeof name === 'string');
}
