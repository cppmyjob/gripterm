/**
 * Runs the repository's real flat config against planted source text and prints
 * what the boundary rule said about each plant, as JSON.
 *
 * A separate process rather than a call inside the suite, and that is Jest's
 * doing rather than a preference: `eslint.config.mjs` is an ES module, ESLint
 * loads it with a dynamic `import()`, and Jest's CommonJS VM refuses one without
 * `--experimental-vm-modules`. Turning that flag on for the whole test run to
 * ask one question would change how every suite is executed.
 *
 * One process for every plant, not one per plant: ESLint builds the type-aware
 * program for the whole workspace before it can answer the first question, and
 * that cost is paid once here.
 *
 * Input: a JSON array of `{ filePath, source }` on stdin, where `filePath` is
 * relative to the repository root and names a file that EXISTS -- only its path
 * is used, and `source` is linted in its place. Nothing is written to disk.
 * Output: a JSON array of arrays of messages, in the order the plants arrived.
 */

import * as path from 'node:path';
import { ESLint } from 'eslint';

const RULE = '@typescript-eslint/no-restricted-imports';
const ROOT = path.resolve(import.meta.dirname, '..', '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const plants = JSON.parse(await readStdin());
const eslint = new ESLint({ cwd: ROOT });
const answers = [];

for (const plant of plants) {
  const results = await eslint.lintText(plant.source, {
    filePath: path.join(ROOT, plant.filePath),
  });
  const messages = results[0] === undefined ? [] : results[0].messages;
  answers.push(messages.filter((message) => message.ruleId === RULE).map((message) => message.message));
}

process.stdout.write(JSON.stringify(answers));
