import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';

/**
 * The forwarder is a FILE that another program runs, so it is tested by being
 * run -- a real `node`, a real socket, a real receiver. Nothing here imports
 * it: `require` would give a module, and what ships is a process.
 *
 * Every case below is about not harming the conversation that is waiting for
 * this process to exit. It holds somebody's turn open while it runs, its exit
 * code is a signal to the CLI, and its stdout is appended to the session.
 */

const SCRIPT = path.join(__dirname, '../../packages/extension/assets/gripterm-forwarder.js');

const PAYLOAD = JSON.stringify({
  session_id: '3f1c2b8a-4d5e-4f60-9a71-b2c3d4e5f607',
  hook_event_name: 'SessionStart',
  source: 'startup',
});

interface Received {
  readonly body: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** A receiver that records one request. `answer: false` accepts and never replies. */
async function receiver(answer = true): Promise<{
  readonly server: Server;
  readonly origin: string;
  readonly first: Promise<Received>;
}> {
  return await new Promise((resolve) => {
    let seen: (value: Received) => void;
    const first = new Promise<Received>((settle) => {
      seen = settle;
    });

    const server = createServer((request: IncomingMessage, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        seen({
          body,
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          method: request.method,
          url: request.url,
        });
        if (answer) {
          response.writeHead(202);
          response.end();
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port.toString()}`, first });
    });
  });
}

async function run(
  args: readonly string[],
  options: { readonly stdin: string | null, readonly token?: string }
): Promise<Run> {
  const started = Date.now();
  const environment = { ...process.env };
  delete environment.GRIPTERM_TOKEN;
  if (options.token !== undefined) {
    environment.GRIPTERM_TOKEN = options.token;
  }

  const child = spawn(process.execPath, [SCRIPT, ...args], { env: environment });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  if (options.stdin !== null) {
    child.stdin.end(options.stdin);
  }

  return await new Promise<Run>((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

describe('the hook forwarder carries an event the CLI will not send over HTTP', () => {
  it('posts the payload verbatim, to the terminal the url names', async () => {
    const { server, origin, first } = await receiver();
    try {
      const url = `${origin}/hooks/550e8400-e29b-41d4-a716-446655440000`;
      const [result, request] = await Promise.all([run([url], { stdin: PAYLOAD }), first]);

      expect(result.code).toBe(0);
      // Verbatim: the journal keeps what arrived, including the payloads from a
      // version whose contract moved under us.
      expect(request.body).toBe(PAYLOAD);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/hooks/550e8400-e29b-41d4-a716-446655440000');
      expect(request.contentType).toBe('application/json');
    } finally {
      server.close();
    }
  });

  it('takes the token from its own environment, where A16 says it will be', async () => {
    // Measured 2026-08-11: a command hook inherits the terminal's environment.
    // That is what keeps the secret out of `settings.json`, which is a file
    // left on disk.
    const { server, origin, first } = await receiver();
    try {
      const [, request] = await Promise.all([
        run([origin], { stdin: PAYLOAD, token: 'activation-secret' }),
        first,
      ]);

      expect(request.authorization).toBe('Bearer activation-secret');
    } finally {
      server.close();
    }
  });

  it('still sends, and lets the receiver refuse, when there is no token', async () => {
    // A 401 is a diagnosis. A forwarder that decided for itself not to send
    // would leave the same silence as a lost event, with nothing in any log.
    const { server, origin, first } = await receiver();
    try {
      const [result, request] = await Promise.all([run([origin], { stdin: PAYLOAD }), first]);

      expect(result.code).toBe(0);
      // `Bearer ` on the wire, `Bearer` on arrival: the header value is
      // trimmed in transit. Either way it carries no token and the receiver
      // answers 401 -- which is the diagnosis we wanted it to reach.
      expect(request.authorization).toBe('Bearer');
    } finally {
      server.close();
    }
  });
});

describe('the hook forwarder never touches the conversation', () => {
  it('writes nothing at all to stdout on the ordinary path', async () => {
    // The stdout of a `SessionStart` hook that exits 0 is appended to the
    // session as `additionalContext`. Anything here is an injection into
    // somebody's conversation.
    const { server, origin, first } = await receiver();
    try {
      const [result] = await Promise.all([run([origin], { stdin: PAYLOAD }), first]);

      expect(result.stdout).toBe('');
    } finally {
      server.close();
    }
  });

  it('exits 0 and says nothing to the session when nobody is listening', async () => {
    // The window closed, or the port moved. Our failure to observe is never the
    // agent's problem.
    const result = await run(['http://127.0.0.1:1/hooks/x'], { stdin: PAYLOAD });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 when it is given no url, and complains where only we can hear', async () => {
    const result = await run([], { stdin: PAYLOAD });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no receiver url');
  });

  it('exits 0 when the url is not a url', async () => {
    const result = await run(['not-a-url'], { stdin: PAYLOAD });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not a url');
  });
});

describe('the hook forwarder is bounded, because it holds a turn open', () => {
  it('gives up on a receiver that accepts and never answers', async () => {
    // A hung Extension Host holds the socket. Without the request timeout this
    // process would sit there until the CLI's own default -- ten minutes.
    const { server, origin, first } = await receiver(false);
    try {
      const [result] = await Promise.all([run([origin], { stdin: PAYLOAD }), first]);

      expect(result.code).toBe(0);
      expect(result.ms).toBeLessThan(4000);
    } finally {
      server.close();
    }
  });

  it('gives up on a producer that opens its stdin and never writes', async () => {
    const result = await run(['http://127.0.0.1:1/hooks/x'], { stdin: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.ms).toBeLessThan(4000);
  }, 10000);
});
