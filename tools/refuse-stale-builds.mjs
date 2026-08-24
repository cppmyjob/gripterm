import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Refuses to start a run whose compiled output is older than its source.
 *
 * **The incident this is made of, 2026-08-24.** Eighty-four integration tests
 * went red on one line -- "the page never said it was ready" -- and stayed red
 * through a day of hypotheses: the page bundle, the policy, the editor version,
 * a contaminated extensions directory, the font wait, a corrupted install. Every
 * one was refuted by measurement, and the cause was none of them: the host was
 * loading `packages/extension/dist/extension.js` from an EARLIER experiment,
 * which still carried a probe page instead of the real one. The source had been
 * put back hours before; nothing had rebuilt the bundle since.
 *
 * `pnpm test:integration` builds first, so the trap never springs there. It
 * springs on `npx vscode-test --run out/tests/integration/one.test.js`, which is
 * what anybody debugging a single suite types -- the very moment a stale bundle
 * costs the most, because every reading of it is being used to decide what is
 * broken.
 *
 * `packages/extension/esbuild.js` has the same guard one level down, over the
 * workspace packages a bundle is built FROM. This is the level above it: over
 * the bundle the editor actually loads, and over the compiled suite that reads
 * it. Both exist for the same reason -- a run that measures something other
 * than what it names is worse than a run that does not happen (§I.1).
 */
export function refuseStaleBuilds() {
  const checks = [
    {
      what: 'the extension bundle this host loads',
      built: ['packages/extension/dist'],
      source: ['packages/extension/src', 'packages/core/src', 'packages/webview/src'],
      remedy: 'pnpm run build && pnpm run build:extension',
    },
    {
      what: 'the compiled integration suite',
      built: ['out/tests/integration'],
      source: ['tests/integration'],
      remedy: 'pnpm run build:integration',
    },
  ];

  for (const check of checks) {
    const built = newest(check.built);
    const source = newest(check.source);
    if (source === null) {
      // No source to be older than. Nothing to say.
      continue;
    }
    if (built === null) {
      throw new Error(
        `${check.what} has not been built at all (${check.built.join(', ')} is empty or missing). ` +
        `Run \`${check.remedy}\`.`
      );
    }
    if (built < source) {
      throw new Error(
        `${check.what} is older than its source, so this run would measure code that is not in it: ` +
        `${check.built.join(', ')} was last written ${new Date(built).toISOString()}, ` +
        `${check.source.join(', ')} at ${new Date(source).toISOString()}. ` +
        `Run \`${check.remedy}\` -- \`vscode-test --run\` builds nothing.`
      );
    }
  }
}

/** The newest modification time under any of these directories, or `null` for none. */
function newest(directories) {
  let found = null;
  for (const directory of directories) {
    const at = newestUnder(join(ROOT, directory));
    if (at !== null && (found === null || at > found)) {
      found = at;
    }
  }
  return found;
}

function newestUnder(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // Absent or unreadable, which the caller turns into its own sentence: this
    // one cannot tell "never built" from "just deleted" and must not guess.
    return null;
  }

  let found = null;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const at = entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs;
    if (at !== null && (found === null || at > found)) {
      found = at;
    }
  }
  return found;
}
