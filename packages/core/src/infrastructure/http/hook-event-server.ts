import { createServer } from 'node:http';
import { ListeningAddress } from '../../domain/entities/listening-address';
import { ConflictError, ListenError } from '../../domain/errors/gripterm-error';
import { parseHookEventPath } from '../../domain/services/hook-endpoint';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TerminalId } from '../../domain/entities/terminal-id';
import type { EventJournal } from '../../domain/ports/event-journal';
import type { HookEventSink } from '../../domain/ports/hook-event-sink';
import type { Logger } from '../../domain/ports/logger';
import type { RequestAuthenticator } from '../../domain/services/request-authenticator';

const LOOPBACK = '127.0.0.1';

/** Ask the operating system for a port rather than naming one -- see `listenWithRetry`. */
const EPHEMERAL = 0;

/**
 * Generous, because a `PostToolUse` carrying a large file read is an ordinary
 * event and not an attack. It exists at all so that one runaway payload cannot
 * take the window's memory with it; the cap is never reached by a healthy CLI.
 */
const DEFAULT_MAX_BODY_BYTES = 8_388_608;

const DEFAULT_BIND_ATTEMPTS = 5;

/** Transient in the sense that a DIFFERENT port would have worked. Nothing else is retried. */
const RETRYABLE_BIND_CODES: ReadonlySet<string> = new Set(['EACCES', 'EADDRINUSE']);

const STATUS_ACCEPTED = 202;
const STATUS_UNAUTHORISED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_PAYLOAD_TOO_LARGE = 413;

export interface HookEventServerOptions {
  readonly authenticator: RequestAuthenticator;
  readonly journal: EventJournal;
  readonly sink: HookEventSink;
  readonly logger: Logger;
  readonly maxBodyBytes?: number;
  readonly bindAttempts?: number;
}

/**
 * The port Claude Code posts this window's hook events to.
 *
 * Two rules shape every line below, and both come from facts rather than taste.
 *
 * ANSWER FIRST, WORK AFTER. A hook that waits is a turn that waits, and the
 * CLI's default hook timeout is ten minutes [binary 2.1.224]. A failed hook is
 * non-blocking [03], so we are never the reason an agent stops -- provided we
 * never hold the connection. Everything after `res.end()` is our own business.
 *
 * TURN AWAY BEFORE ALLOCATING. The socket is on loopback, which means every
 * process on this machine can reach it. The token is checked before the body is
 * read, so an unauthenticated peer cannot make us allocate; the terminal is
 * checked before the body is read too, so the port cannot be used to invent
 * records from outside (§4.6).
 *
 * It does NOT parse. The §4.7 sketch gave it a `HookEventParser`, and that has
 * been moved to the sink: parsing on the request path would put the payloads we
 * CANNOT read -- the ones from a version whose contract changed, which are the
 * ones worth keeping -- at risk of being dropped before the journal saw them.
 */
export class HookEventServer {
  private readonly _options: HookEventServerOptions;
  private _server: Server | null = null;

  constructor(options: HookEventServerOptions) {
    this._options = options;
  }

  public async start(): Promise<ListeningAddress> {
    if (this._server !== null) {
      throw new ConflictError('the hook event server is already listening');
    }
    const server = createServer((request, response) => {
      this._handle(request, response);
    });
    // Ours are short POSTs from a local process; an idle socket held open is
    // one more thing `stop()` has to interrupt at shutdown.
    server.keepAliveTimeout = 0;
    this._server = server;

    try {
      const port = await listenWithRetry(
        async () => await bindOnce(server),
        this._options.bindAttempts ?? DEFAULT_BIND_ATTEMPTS
      );
      return ListeningAddress.loopback(port);
    } catch (error: unknown) {
      this._server = null;
      server.close();
      throw error;
    }
  }

  /** Idempotent, including before the first `start`: shutdown must not need a state check. */
  public async stop(): Promise<void> {
    const server = this._server;
    if (server === null) {
      return;
    }
    this._server = null;
    // Without this, `close` waits for every open connection and a single
    // lingering socket turns shutdown into a hang the editor blames on us.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private _handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST') {
      /*
       * Said, and it was not until Ш3.
       *
       * This port's own doc justifies the `Logger` by "the receiver has three
       * failures that are invisible by construction". These two were a fourth
       * and a fifth: a request that is not a POST, and a path this build cannot
       * read -- both turned away with a status code and no trace anywhere. They
       * are exactly what contract drift looks like from here: a proxy in the
       * way, a `settings.json` left from a previous activation naming an old
       * port, a forwarder out of another build. And "my hooks are not arriving"
       * is the commonest question this product is asked.
       */
      this._options.logger.warn('a request to the hook port was not a POST, so it was turned away', {
        method: request.method ?? null,
        path: request.url ?? null,
      });
      answer(response, STATUS_METHOD_NOT_ALLOWED);
      return;
    }

    const terminalId = parseHookEventPath(request.url);
    if (terminalId === null) {
      this._options.logger.warn('a request to the hook port did not name a terminal, so it was turned away', {
        path: request.url ?? null,
      });
      answer(response, STATUS_NOT_FOUND);
      return;
    }

    if (!this._options.authenticator.isAuthorised(request.headers.authorization)) {
      this._options.logger.warn('a hook event arrived without a valid token', {
        terminalId: terminalId.value,
      });
      answer(response, STATUS_UNAUTHORISED);
      return;
    }

    if (!this._options.sink.knows(terminalId)) {
      this._options.logger.warn('a hook event named a terminal we do not know', {
        terminalId: terminalId.value,
      });
      answer(response, STATUS_NOT_FOUND);
      return;
    }

    this._readBody(request)
      .then((raw) => {
        if (raw === null) {
          this._options.logger.warn('a hook event body was refused for its size', {
            terminalId: terminalId.value,
          });
          answer(response, STATUS_PAYLOAD_TOO_LARGE);
          return;
        }
        answer(response, STATUS_ACCEPTED);
        this._dispatch({ terminalId, receivedAt: new Date(), raw });
      })
      .catch((cause: unknown) => {
        // A body that never finished arriving. The socket is already gone or
        // going; there is nobody to answer, so this is a log and nothing else.
        this._options.logger.error('a hook event request failed while being read', {
          terminalId: terminalId.value,
          cause,
        });
      });
  }

  /**
   * Both consumers are started, and neither can silence the other. A journal
   * that refuses must not cost the tree its update, and a sink that throws must
   * not cost the history its line -- the two failures are independent, and
   * treating them as one would make the rarer one invisible.
   */
  private _dispatch(delivery: {
    readonly terminalId: TerminalId;
    readonly receivedAt: Date;
    readonly raw: string;
  }): void {
    this._options.journal.append(delivery).catch((cause: unknown) => {
      this._options.logger.error('could not journal a hook event', {
        terminalId: delivery.terminalId.value,
        cause,
      });
    });

    try {
      this._options.sink.receive(delivery);
    } catch (cause: unknown) {
      this._options.logger.error('a hook event was not applied', {
        terminalId: delivery.terminalId.value,
        cause,
      });
    }
  }

  /** Resolves to the body, or to `null` when it passed the cap. */
  private async _readBody(request: IncomingMessage): Promise<string | null> {
    const cap = this._options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return await new Promise<string | null>((resolve, reject) => {
      let chunks: Buffer[] | null = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) {
          // Dropped, but the listener stays attached and the stream keeps
          // flowing: the socket has to stay readable for our 413 to reach the
          // caller. Destroying the request instead gives it a hang-up and no
          // status at all. Every later chunk lands here too -- `size` only
          // grows -- so no second guard is needed, and one written here was
          // removed after a mutation showed it changed nothing.
          chunks = null;
          resolve(null);
          return;
        }
        chunks?.push(chunk);
      });
      request.on('end', () => {
        // A no-op once the cap already resolved this promise.
        resolve(chunks === null ? null : Buffer.concat(chunks).toString('utf8'));
      });
      // Two listeners, and they are here for two DIFFERENT reasons rather than
      // as insurance for each other. `error` carries the cause, which is the
      // only thing worth logging. `close` carries the guarantee: Node does not
      // promise `error` on an aborted request, and a promise that never settles
      // holds its buffers for the life of the window.
      //
      // Measured by mutation 2026-08-11: on this platform EITHER alone settles
      // the promise, so neither is individually necessary HERE. That is a fact
      // about Node 22 on Windows and not a contract, which is exactly why the
      // guarantee is not left resting on it (§8.2).
      request.on('error', reject);
      request.on('close', () => {
        if (!request.complete) {
          reject(new Error('the request ended before its body had arrived'));
        }
      });
    });
  }
}

/**
 * Binds, and treats a refusal as a reason to ask for a different port.
 *
 * This exists because of a measurement rather than a theory: on Windows,
 * `listen` returns EACCES for a loopback port that nothing is using, when the
 * port falls inside one of WinNAT's excluded ranges -- 34 of them on this
 * machine, reassigned at every boot (2026-08-11, §2.1a). A fixed port from
 * configuration would therefore fail on some machines, for some numbers, and
 * differently after a reboot.
 *
 * Only a code that a DIFFERENT port would fix is retried. Everything else is
 * rethrown untouched: retrying an EINVAL five times turns one clear failure
 * into five identical log lines and a delay.
 */
export async function listenWithRetry(
  attempt: () => Promise<number>,
  attempts: number
): Promise<number> {
  let last: unknown;
  for (let taken = 0; taken < attempts; taken += 1) {
    try {
      return await attempt();
    } catch (error: unknown) {
      if (!RETRYABLE_BIND_CODES.has(codeOf(error))) {
        throw error;
      }
      last = error;
    }
  }
  throw new ListenError(`could not take a loopback port in ${String(attempts)} attempts`, {
    cause: last,
    details: { attempts },
  });
}

/**
 * One `listen`, as a promise, with both outcomes wired and neither left dangling.
 *
 * `port` defaults to the ephemeral 0 that production always uses. It is a
 * parameter because a refusal from the operating system cannot otherwise be
 * observed: EACCES depends on WinNAT ranges that move at every boot, while
 * EADDRINUSE against a port taken on purpose is deterministic on every machine.
 * The alternative was to leave the error path covered by a stub, which proves
 * the branch runs and nothing about what a real refusal looks like.
 */
export async function bindOnce(server: Server, port: number = EPHEMERAL): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(portOf(server.address()));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK);
  });
}

/**
 * The TCP port a listening server took, or 0 for the two shapes that are not
 * one: `null` (not listening) and a string (a unix socket or a named pipe).
 *
 * Total on purpose. Both of those are unreachable here -- this is only ever
 * called from a `listening` handler for a TCP bind -- and an unreachable branch
 * inside the server would be a rule nothing can hold. Zero is not a fallback
 * either: `ListeningAddress` refuses it, because a settings file naming port 0
 * is an observation channel that is dead on arrival while looking ordinary.
 */
export function portOf(address: ReturnType<Server['address']>): number {
  return address === null || typeof address === 'string' ? 0 : address.port;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

/**
 * Always empty-bodied. The CLI READS a hook's reply, so anything returned here
 * could steer the conversation -- the same hazard PM5-1 named for the
 * `SessionStart` forwarder, where stray output arrives as `additionalContext`.
 */
function answer(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Length': '0' });
  response.end();
}
