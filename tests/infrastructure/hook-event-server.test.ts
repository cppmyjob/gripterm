import { createServer, request } from 'node:http';
import {
  ConflictError,
  HookEventServer,
  ListenError,
  RequestAuthenticator,
  TerminalId,
  bindOnce,
  listenWithRetry,
  portOf,
  type EventJournal,
  type HookDelivery,
  type HookEventSink,
  type ListeningAddress,
} from '../../packages/core/src/index';
import { RecordingLogger } from '../helpers/port-fakes';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * The oracle for the receiver.
 *
 * Every assertion here is about ORDER or about REFUSAL, because those are the
 * two things that cannot be checked by reading the code afterwards:
 *
 *  - A hook whose request is not answered promptly stalls the conversation. The
 *    CLI treats a failed hook as non-blocking [03], so we are never the reason
 *    an agent stops -- but only if we answer first and work afterwards. The
 *    test for that blocks the journal and demands the response anyway.
 *  - The port is on loopback, so every process on this machine can reach it.
 *    Wrong token, unknown terminal and wrong method must each cost the caller a
 *    status and cost us nothing -- no journal line, no sink call, and for the
 *    unauthenticated case not even a body read.
 */

const TOKEN = 'a'.repeat(64);
const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const OTHER_TERMINAL = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
const BODY = '{"hook_event_name":"Stop","session_id":"s-1"}';

class SpyJournal implements EventJournal {
  public readonly appended: HookDelivery[] = [];
  private _gate: Promise<void> = Promise.resolve();

  /** Holds every append until `release` is called. */
  public block(): () => void {
    let release = (): void => undefined;
    this._gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  public async append(delivery: HookDelivery): Promise<void> {
    await this._gate;
    this.appended.push(delivery);
  }
}

class SpySink implements HookEventSink {
  public readonly received: HookDelivery[] = [];
  public known: readonly TerminalId[] = [TERMINAL];

  public knows(terminalId: TerminalId): boolean {
    return this.known.some((candidate) => candidate.equals(terminalId));
  }

  public receive(delivery: HookDelivery): void {
    this.received.push(delivery);
  }
}

interface Stand {
  readonly server: HookEventServer;
  readonly address: ListeningAddress;
  readonly journal: SpyJournal;
  readonly sink: SpySink;
  readonly logger: RecordingLogger;
}

/** Registered synchronously at construction, so nothing started can outlive its test. */
const started: HookEventServer[] = [];

async function start(overrides: { readonly maxBodyBytes?: number } = {}): Promise<Stand> {
  const journal = new SpyJournal();
  const sink = new SpySink();
  const logger = new RecordingLogger();
  const server = new HookEventServer({
    authenticator: new RequestAuthenticator(TOKEN),
    journal,
    sink,
    logger,
    ...overrides,
  });
  started.push(server);
  return { server, address: await server.start(), journal, sink, logger };
}

afterEach(async () => {
  for (const server of started.splice(0)) {
    await server.stop();
  }
});

interface Reply {
  readonly status: number;
  readonly body: string;
}

async function post(
  address: ListeningAddress,
  path: string,
  body: string,
  headers: Readonly<Record<string, string>> = { Authorization: `Bearer ${TOKEN}` },
  method = 'POST'
): Promise<Reply> {
  return await new Promise<Reply>((resolve, reject) => {
    const call = request(
      { host: address.host, port: address.port, path, method, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: text });
        });
      }
    );
    call.on('error', reject);
    call.end(body);
  });
}

function eventPath(terminalId = TERMINAL): string {
  return `/ev/${terminalId.value}`;
}

/**
 * Lets the microtasks queued after the response run.
 *
 * A yield and not a wait, which is why a number of milliseconds is honest here
 * and nowhere else in this file: the server and this test share one event loop,
 * so the work behind an answer is already queued when the answer arrives, and
 * only the turn is needed. Measured 2026-08-24 by setting it to zero -- all 35
 * tests here still pass, so the duration carries nothing.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Waits for what the server has done, rather than for a number of milliseconds.
 *
 * Used where the thing being waited for is the OPERATING SYSTEM's and not ours
 * -- a socket the caller tore down -- so no number of turns can count it and a
 * sleep is a bet on how fast the event arrives.
 */
async function until(reached: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await reached()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('the server never noticed');
}

describe('HookEventServer: where it listens', () => {
  it('binds loopback on a port the operating system chose', async () => {
    const { address } = await start();
    expect(address.host).toBe('127.0.0.1');
    // Not a fixed number from configuration: on Windows a free port can still
    // be refused, because WinNAT reserves 34 ranges and reassigns them at every
    // boot -- measured 2026-08-11, `listen EACCES` on an idle 51337.
    expect(address.port).toBeGreaterThan(0);
  });

  it('refuses to start twice', async () => {
    const { server } = await start();
    await expect(server.start()).rejects.toBeInstanceOf(ConflictError);
  });

  it('stops, and the port stops answering', async () => {
    const { server, address } = await start();
    await server.stop();

    await expect(post(address, eventPath(), BODY)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('can be stopped without ever having started', async () => {
    const server = new HookEventServer({
      authenticator: new RequestAuthenticator(TOKEN),
      journal: new SpyJournal(),
      sink: new SpySink(),
      logger: new RecordingLogger(),
    });
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe('HookEventServer: an event from a terminal we started', () => {
  it('is accepted', async () => {
    const { address } = await start();
    expect((await post(address, eventPath(), BODY)).status).toBe(202);
  });

  it('is answered with an empty body', async () => {
    // The CLI reads a hook's reply. Anything we return could steer the
    // conversation -- the same hazard PM5-1 named for the `SessionStart`
    // forwarder, where stray output becomes `additionalContext`.
    const { address } = await start();
    expect((await post(address, eventPath(), BODY)).body).toBe('');
  });

  it('reaches the journal exactly as it arrived', async () => {
    const { address, journal } = await start();
    await post(address, eventPath(), BODY);
    await settle();

    expect(journal.appended).toHaveLength(1);
    expect(journal.appended[0]?.raw).toBe(BODY);
    expect(journal.appended[0]?.terminalId.equals(TERMINAL)).toBe(true);
    expect(journal.appended[0]?.receivedAt).toBeInstanceOf(Date);
  });

  it('reaches the sink as well as the journal', async () => {
    const { address, sink } = await start();
    await post(address, eventPath(), BODY);
    await settle();

    expect(sink.received.map((delivery) => delivery.raw)).toStrictEqual([BODY]);
  });

  it('survives a body that is not JSON, because reading it is not our job here', async () => {
    // The receiver never parses. Doing so would put a payload we cannot read on
    // the request path, and the payload we cannot read is the one worth keeping.
    const { address, journal } = await start();
    expect((await post(address, eventPath(), 'not json at all')).status).toBe(202);
    await settle();
    expect(journal.appended[0]?.raw).toBe('not json at all');
  });

  it('survives an empty body', async () => {
    const { address, journal } = await start();
    expect((await post(address, eventPath(), '')).status).toBe(202);
    await settle();
    expect(journal.appended[0]?.raw).toBe('');
  });
});

describe('HookEventServer: the answer comes before the work', () => {
  it('replies while the journal is still blocked', async () => {
    const { address, journal } = await start();
    const release = journal.block();

    const reply = await post(address, eventPath(), BODY);

    expect(reply.status).toBe(202);
    expect(journal.appended).toHaveLength(0);

    release();
    await settle();
    expect(journal.appended).toHaveLength(1);
  });

  it('keeps answering while a previous event is still being written', async () => {
    // A hung consumer must not become a hung conversation: a hook that waits is
    // a turn that waits, and the default hook timeout is ten minutes (§4.7).
    const { address, journal } = await start();
    const release = journal.block();

    expect((await post(address, eventPath(), '{"n":1}')).status).toBe(202);
    expect((await post(address, eventPath(), '{"n":2}')).status).toBe(202);

    release();
    await settle();
    expect(journal.appended).toHaveLength(2);
  });
});

describe('HookEventServer: what it turns away', () => {
  it('answers 401 to a wrong token, and records nothing', async () => {
    const { address, journal, sink } = await start();
    const reply = await post(address, eventPath(), BODY, { Authorization: 'Bearer wrong' });
    await settle();

    expect(reply.status).toBe(401);
    expect(journal.appended).toHaveLength(0);
    expect(sink.received).toHaveLength(0);
  });

  it('answers 401 when there is no token at all', async () => {
    const { address } = await start();
    expect((await post(address, eventPath(), BODY, {})).status).toBe(401);
  });

  it('answers 404 for a terminal it does not know, and creates nothing', async () => {
    // Otherwise the port is a way for anything holding the token to invent
    // records from outside (§4.6).
    const { address, journal, sink } = await start();
    const reply = await post(address, eventPath(OTHER_TERMINAL), BODY);
    await settle();

    expect(reply.status).toBe(404);
    expect(journal.appended).toHaveLength(0);
    expect(sink.received).toHaveLength(0);
  });

  it.each([
    ['a path that is not ours', '/metrics'],
    ['the prefix with no id', '/ev/'],
    ['an id that is not a uuid', '/ev/not-a-uuid'],
  ])('answers 404 to %s', async (_label, path) => {
    const { address } = await start();
    expect((await post(address, path, BODY)).status).toBe(404);
  });

  it.each(['GET', 'PUT', 'DELETE'])('answers 405 to %s', async (method) => {
    const { address } = await start();
    expect(
      (await post(address, eventPath(), '', { Authorization: `Bearer ${TOKEN}` }, method)).status
    ).toBe(405);
  });

  it('answers 413 to a body past the cap, and records nothing', async () => {
    // Half a megabyte, so the body arrives in MANY chunks: the cap has to hold
    // for every chunk after the first one that crossed it, and a check that only
    // looked at the first would still pass on a small body.
    const { address, journal } = await start({ maxBodyBytes: 64 });
    const reply = await post(address, eventPath(), 'x'.repeat(512 * 1024));
    await settle();

    expect(reply.status).toBe(413);
    expect(journal.appended).toHaveLength(0);
  });

  it('checks the token before it reads a body', async () => {
    // Order, not politeness: an unauthenticated peer on loopback must not be
    // able to make us allocate. With the cap set below the body size, a reader
    // that ran first would answer 413 instead of 401.
    const { address } = await start({ maxBodyBytes: 8 });
    const reply = await post(address, eventPath(), 'x'.repeat(4096), { Authorization: 'Bearer no' });
    expect(reply.status).toBe(401);
  });
});

describe('HookEventServer: when it cannot take a port at all', () => {
  it('reports a ListenError and stays reusable', async () => {
    // Zero attempts, because a real EACCES cannot be provoked: WinNAT's
    // excluded ranges move at every boot, so a test that tried to hit one would
    // pass or fail by luck. What is being checked is not the bind but the
    // CLEAN-UP -- an object left holding a dead server would answer every later
    // `start` with a conflict and never listen again.
    const server = new HookEventServer({
      authenticator: new RequestAuthenticator(TOKEN),
      journal: new SpyJournal(),
      sink: new SpySink(),
      logger: new RecordingLogger(),
      bindAttempts: 0,
    });

    await expect(server.start()).rejects.toBeInstanceOf(ListenError);
    // The SECOND failure is the assertion that matters. An object that kept its
    // dead server would answer this with a ConflictError -- "already listening"
    // -- and would never listen again for the life of the window.
    await expect(server.start()).rejects.toBeInstanceOf(ListenError);
  });
});

describe('HookEventServer: when the caller vanishes mid-body', () => {
  it('logs it instead of leaving a promise pending for the life of the window', async () => {
    const { address, logger } = await start();

    await new Promise<void>((resolve) => {
      const call = request({
        host: address.host,
        port: address.port,
        path: eventPath(),
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Length': '1000' },
      });
      call.on('error', () => undefined);
      call.write('{"partial":', () => {
        // The body promised 1000 bytes and 11 arrived. An aborted request does
        // not reliably emit `error`, so without the `close` guard this promise
        // -- and its buffers -- would live until the window closed.
        call.destroy();
        resolve();
      });
    });
    // Waited for by there being an error at all, and asserted below by what it
    // says. The server learns of the abort from the socket, which is an event
    // of the platform's rather than of ours, so the 80 ms sleep that used to
    // stand here was a bet on how fast that event arrives: shortening it to
    // zero fails this test every time with an empty list, which is how the bet
    // was measured rather than argued (2026-08-24).
    await until(() => logger.errors.length > 0);

    expect(logger.errors.map((entry) => entry.message)).toContain(
      'a hook event request failed while being read'
    );
  });
});

describe('HookEventServer: when the work behind the answer fails', () => {
  it('logs a journal failure instead of losing it in a promise', async () => {
    const { address, logger, sink, journal } = await start();
    journal.append = async (): Promise<void> => { await Promise.reject(new Error('disk full')); };

    expect((await post(address, eventPath(), BODY)).status).toBe(202);
    await settle();

    expect(logger.errors.map((entry) => entry.message)).toContain(
      'could not journal a hook event'
    );
    // The sink still gets it: one broken consumer must not silence the other.
    expect(sink.received).toHaveLength(1);
  });

  it('logs a sink failure and still journals', async () => {
    const { address, logger, journal, sink } = await start();
    sink.receive = (): void => {
      throw new Error('registry exploded');
    };

    expect((await post(address, eventPath(), BODY)).status).toBe(202);
    await settle();

    expect(logger.errors.map((entry) => entry.message)).toContain('a hook event was not applied');
    expect(journal.appended).toHaveLength(1);
  });
});

describe('listenWithRetry', () => {
  /**
   * The retry rule on its own, because the failure it exists for cannot be
   * produced on demand: WinNAT's excluded ranges are reassigned at boot, so a
   * test that tried to provoke a real EACCES would be green or red by luck.
   */
  const fails = (code: string): Error & { code?: string } =>
    Object.assign(new Error(code), { code });

  it('retries a port refused by the operating system', async () => {
    const codes = ['EACCES', 'EADDRINUSE'];
    let calls = 0;
    const port = await listenWithRetry(async () => {
      calls += 1;
      const code = codes[calls - 1];
      return code === undefined ? await Promise.resolve(51_000 + calls) : await Promise.reject(fails(code));
    }, 4);

    expect(calls).toBe(3);
    expect(port).toBe(51_003);
  });

  it('gives up with a named error rather than retrying forever', async () => {
    let calls = 0;
    const attempt = async (): Promise<number> => {
      calls += 1;
      return await Promise.reject(fails('EACCES'));
    };
    await expect(listenWithRetry(attempt, 3)).rejects.toBeInstanceOf(ListenError);
    expect(calls).toBe(3);
  });

  it('does not retry a failure that retrying cannot fix', async () => {
    let calls = 0;
    const attempt = async (): Promise<number> => {
      calls += 1;
      return await Promise.reject(fails('EINVAL'));
    };
    await expect(listenWithRetry(attempt, 5)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toBe(1);
  });

  it('does not retry something that is not an error at all', async () => {
    let calls = 0;
    const attempt = async (): Promise<number> => {
      calls += 1;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a rejection that is NOT an Error is exactly the case under test
      return await Promise.reject('a bare string');
    };
    await expect(listenWithRetry(attempt, 5)).rejects.toBe('a bare string');
    expect(calls).toBe(1);
  });
});

describe('bindOnce against a real refusal', () => {
  it('rejects with the operating system code instead of hanging', async () => {
    // A genuine EADDRINUSE, deterministic on every machine -- unlike the EACCES
    // this whole retry exists for, which depends on WinNAT ranges that move at
    // every boot. What is proven here is that a refusal ARRIVES: a `listen` that
    // failed with neither `listening` nor a rejected promise would leave the
    // window starting up forever.
    const blocker = createServer();
    const taken = await bindOnce(blocker, 0);
    const second = createServer();

    await expect(bindOnce(second, taken)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    second.close();
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
  });
});

describe('portOf', () => {
  it.each([
    ['nothing bound', null, 0],
    ['a named pipe', '\\\\.\\pipe\\x', 0],
  ])('answers 0 for %s, which ListeningAddress then refuses', (_label, address, expected) => {
    expect(portOf(address)).toBe(expected);
  });

  it('answers the port of a TCP bind', () => {
    expect(portOf({ address: '127.0.0.1', family: 'IPv4', port: 52_066 })).toBe(52_066);
  });
});
