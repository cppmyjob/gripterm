/**
 * A producer with numbered lines, for questions (3) and (5).
 *
 * Numbered because "the output looked fine" is not an answer: after a resize
 * under a live stream the screen can lose a line or print one twice, and the
 * only way to see that from code is to count the numbers afterwards.
 *
 * Writes in large batches on purpose -- the question is what happens when a pty
 * hands us data faster than a webview can swallow it, and a polite producer
 * would answer a different question.
 *
 * `pauseEvery` and `pauseMs` exist for question (5) only: a resize is meant to
 * land WHILE the stream is running, and a producer that finishes in 1.3 s is
 * over before the second resize. Measured 2026-08-17: four of five resizes threw
 * "Cannot resize a pty that has already exited", so what got measured was a
 * resize of a draining screen -- a real case, but not the one the plan asked
 * for. With a pause the producer spans the whole sequence.
 *
 * Usage: node producer.js <lines> <lineWidth> [pauseEvery] [pauseMs]
 */

'use strict';

const lines = Number(process.argv[2] ?? '20000');
const width = Number(process.argv[3] ?? '90');
const pauseEvery = Number(process.argv[4] ?? '0');
const pauseMs = Number(process.argv[5] ?? '0');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function main() {
  let batch = '';
  for (let i = 1; i <= lines; i += 1) {
    const tag = `L${String(i).padStart(6, '0')}`;
    batch += `${tag} ${'x'.repeat(Math.max(0, width - tag.length - 1))}\r\n`;
    if (batch.length > 65536) {
      process.stdout.write(batch);
      batch = '';
    }
    if (pauseEvery > 0 && i % pauseEvery === 0) {
      process.stdout.write(batch);
      batch = '';
      await sleep(pauseMs);
    }
  }
  if (batch.length > 0) {
    process.stdout.write(batch);
  }
}

void main();
