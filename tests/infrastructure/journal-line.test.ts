import { JOURNAL_LINE_VERSION, TerminalId, decodeJournalLine, encodeJournalLine } from '../../packages/core/src/index';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * One line of the journal, and the filter that decides how much of a payload
 * reaches the disk.
 *
 * The filter is an ALLOWLIST, and that is the whole design: Claude Code adds
 * fields between builds, so a list of things to strip would leak every new one
 * until somebody noticed. Here an unknown field is dropped and its NAME is kept,
 * which is the difference between a person being able to see that something was
 * withheld and the record quietly not mentioning it.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const AT = new Date('2026-08-11T09:30:15.250Z');

const SECRET = 'the password is hunter2';

function encode(raw: string, includeContent = false, seq = 1): string {
  return encodeJournalLine({
    seq,
    delivery: { terminalId: TERMINAL, receivedAt: AT, raw },
    includeContent,
  });
}

function fields(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('writing a line with the content filter on (the default)', () => {
  const BODY = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'ac2d74d7-1f3b-4c5e-9a80-0d1e2f3a4b5c',
    cwd: 'D:/Projects/foo',
    user_input: SECRET,
    tool_input: { command: SECRET },
  });

  it('does not put the texts in the file at all', async () => {
    expect(encode(BODY)).not.toContain('hunter2');
  });

  it('keeps the structural fields a reader still needs', async () => {
    expect(fields(encode(BODY)).body).toStrictEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'ac2d74d7-1f3b-4c5e-9a80-0d1e2f3a4b5c',
      cwd: 'D:/Projects/foo',
    });
  });

  it('records the NAMES of what it left out, so the loss is visible', async () => {
    expect(fields(encode(BODY)).dropped).toStrictEqual(['user_input', 'tool_input']);
  });

  it('drops a field this build has never heard of, rather than passing it through', async () => {
    // The reason for an allowlist. A denylist would carry `whatever_they_add_next`
    // into the file until somebody read a changelog.
    const line = encode(JSON.stringify({ hook_event_name: 'Stop', whatever_they_add_next: SECRET }));

    expect(line).not.toContain('hunter2');
    expect(fields(line).dropped).toStrictEqual(['whatever_they_add_next']);
  });

  it('drops an object parked under a name it allows', async () => {
    // `tool_input` is an object, and so could `cwd` be if a build changed its
    // mind. Allowing the KEY is not allowing whatever is under it.
    const line = encode(JSON.stringify({ hook_event_name: 'Stop', cwd: { path: SECRET } }));

    expect(line).not.toContain('hunter2');
    expect(fields(line).dropped).toStrictEqual(['cwd']);
  });

  it('keeps a null under an allowed name, which is a value and not a container', async () => {
    expect(fields(encode(JSON.stringify({ tool_name: null }))).body).toStrictEqual({
      tool_name: null,
    });
  });

  it.each([
    ['a body that is not JSON', 'this is not json'],
    ['a body that is JSON but not an object', '"just a string"'],
    ['an empty body', ''],
  ])('withholds %s entirely, since it cannot be filtered field by field', async (_name, raw) => {
    const line = fields(encode(raw));

    expect(line.raw).toBeUndefined();
    expect(line.body).toBeUndefined();
    expect(line.withheld).toBe(raw.length);
  });
});

describe('writing a line with the content filter off', () => {
  it('keeps the body byte for byte', async () => {
    const raw = '{"user_input":"the password is hunter2"}';

    expect(fields(encode(raw, true)).raw).toBe(raw);
  });

  it('stamps the schema, the counter, the moment and the terminal', async () => {
    expect(fields(encode('{"n":1}', true, 17))).toStrictEqual({
      v: JOURNAL_LINE_VERSION,
      seq: 17,
      at: '2026-08-11T09:30:15.250Z',
      terminalId: TERMINAL_UUID,
      raw: '{"n":1}',
    });
  });
});

describe('reading a line back', () => {
  it('gives a parser the body when the body was kept', async () => {
    const decoded = decodeJournalLine(encode('{"hook_event_name":"Stop"}', true));

    expect(decoded).toStrictEqual({
      kind: 'line',
      line: {
        seq: 1,
        at: AT,
        terminalId: TERMINAL_UUID,
        payload: { hook_event_name: 'Stop' },
        raw: '{"hook_event_name":"Stop"}',
        dropped: [],
      },
    });
  });

  /*
   * The property the whole filter is built around: a journal written with
   * content off is still a journal the projector (M2.4b) can replay, minus the
   * texts. That works only because redaction keeps the names a hook parser
   * reads, so the two shapes converge on one `payload`.
   */
  it('gives a parser the surviving fields when the body was redacted', async () => {
    const decoded = decodeJournalLine(
      encode('{"hook_event_name":"Stop","last_assistant_message":"hunter2"}')
    );

    expect(decoded.kind === 'line' ? decoded.line.payload : null).toStrictEqual({
      hook_event_name: 'Stop',
    });
    expect(decoded.kind === 'line' ? decoded.line.dropped : []).toStrictEqual([
      'last_assistant_message',
    ]);
  });

  it('offers no payload at all for a body that was withheld whole', async () => {
    const decoded = decodeJournalLine(encode('not json'));

    expect(decoded.kind === 'line' ? decoded.line.payload : 'wrong').toBeNull();
  });

  it('offers no payload for a kept body that is not JSON, rather than inventing one', async () => {
    const decoded = decodeJournalLine(encode('not json', true));

    expect(decoded.kind === 'line' ? decoded.line.payload : 'wrong').toBeNull();
    expect(decoded.kind === 'line' ? decoded.line.raw : null).toBe('not json');
  });

  it('reads a version 1 line, which had no counter', async () => {
    // There are such lines on this machine, written by M1. A journal is the one
    // thing no later version can go back for, so the reader keeps up with the
    // shapes rather than the other way round.
    const decoded = decodeJournalLine(
      JSON.stringify({ v: 1, at: AT.toISOString(), terminalId: TERMINAL_UUID, raw: '{"n":1}' })
    );

    expect(decoded.kind === 'line' ? decoded.line.seq : 'wrong').toBeNull();
    expect(decoded.kind === 'line' ? decoded.line.payload : null).toStrictEqual({ n: 1 });
  });

  it.each([
    ['a torn write', '{"v":2,"seq":3,"at":"2026-08-11T09:00'],
    ['a line that is not an object', '["v",2]'],
    ['a line with no moment', '{"v":2,"terminalId":"x"}'],
    ['a line with no terminal', '{"v":2,"at":"2026-08-11T09:00:00.000Z"}'],
    ['a moment that is not one', '{"v":2,"at":"the eleventh","terminalId":"x"}'],
  ])('refuses %s rather than guessing at it', async (_name, text) => {
    expect(decodeJournalLine(text).kind).toBe('unreadable');
  });

  it('ignores a dropped list that is not a list of names', async () => {
    const decoded = decodeJournalLine(
      JSON.stringify({ v: 2, at: AT.toISOString(), terminalId: TERMINAL_UUID, dropped: [1, 'ok'] })
    );

    expect(decoded.kind === 'line' ? decoded.line.dropped : null).toStrictEqual(['ok']);
  });

  it('reads a missing dropped list as nothing having been dropped', async () => {
    const decoded = decodeJournalLine(
      JSON.stringify({ v: 2, at: AT.toISOString(), terminalId: TERMINAL_UUID })
    );

    expect(decoded.kind === 'line' ? decoded.line.dropped : null).toStrictEqual([]);
  });
});
