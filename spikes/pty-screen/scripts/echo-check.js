/**
 * The other end of M3.2 question (10): a child that says exactly what arrived.
 *
 * A11 was declared closed on the grounds that we "write bytes", but the subject
 * of A11 is a command broken up on a long line, and that subject moved from
 * `sendText` into the write -- it did not disappear. node-pty before 1.1.0
 * shuffled and dropped pastes over 1024 characters (node-pty#831). So the child
 * hashes what it received and prints the hash; the caller compares it with the
 * hash of what it sent. Nothing here trusts the echo on the screen.
 *
 * Raw mode matters twice: it stops the console from doing line editing on our
 * payload, and it stops the echo, which would otherwise put 64 KiB back on the
 * output path and drown the answer. Raw mode is set before READY is printed, and
 * the caller waits for READY -- otherwise the first payload would race it.
 */

'use strict';

const crypto = require('node:crypto');

const TERMINATOR = '\r';

let buffer = '';

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

process.stdin.on('data', (chunk) => {
  let rest = chunk;
  for (;;) {
    const at = rest.indexOf(TERMINATOR);
    if (at === -1) {
      buffer += rest;
      return;
    }
    buffer += rest.slice(0, at);
    const sha = crypto.createHash('sha256').update(buffer, 'utf8').digest('hex');
    process.stdout.write(
      `\nECHOCHECK chars=${buffer.length} bytes=${Buffer.byteLength(buffer, 'utf8')} sha=${sha} END\n`,
    );
    buffer = '';
    rest = rest.slice(at + TERMINATOR.length);
  }
});

process.stdout.write('READY\n');
