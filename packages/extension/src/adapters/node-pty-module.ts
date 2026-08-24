import { join } from 'node:path';
import type * as NodePty from 'node-pty';
import type { Logger } from '@gripterm/core';

/**
 * Loading the native pty, and the two rules the measurements left behind.
 *
 * **It is required by PATH, not by name.** `vsce` ignores `node_modules/**` in
 * its own glob before any `.vscodeignore` is read, and does not follow pnpm's
 * symlinks, so a dependency cannot reach a published archive by being a
 * dependency. `build:extension` copies the package into `assets/node-pty/`
 * instead (M3.12), and this is the only place that knows where that is.
 *
 * **It is LAZY and it is caught.** A static import would make a machine without
 * the addon a machine without the extension: activation would throw before the
 * list, the log and the fallback exist, and the person would be left with an
 * editor that says an extension failed to activate. Caught here, the same
 * machine gets terminals on the editor engine and a line saying why (O5).
 *
 * **A successful `require` is NOT proof that the addon works.** Measured
 * 2026-08-17: `require('node-pty')` returns an object -- with `spawn` a function
 * on it -- for a package whose `build/Release` is missing entirely, because the
 * `.node` file is not touched until something is spawned. So this function
 * answers "there is a module here", and only a running process answers the rest;
 * that is what the integration suite spawns rather than asserting on a type.
 */

export type NodePtyModule = typeof NodePty;

/** Where `build:extension` leaves the copy, relative to the extension. */
const COPY = ['assets', 'node-pty'];

export function loadNodePty(extensionPath: string, logger: Logger): NodePtyModule | null {
  const directory = join(extensionPath, ...COPY);
  try {
    /*
     * A require of an absolute PATH, and deliberately not of the name
     * `node-pty`. The bare name resolves through `node_modules`, which exists
     * beside a development checkout and never inside an installed extension --
     * so the bare form would work here, work in the integration host, and fail
     * on the first machine that installed the VSIX.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the whole point: a load that may fail, at the moment it is needed
    const loaded = require(directory) as NodePtyModule;
    logger.info('the native terminal is loaded, so terminals of our own are possible', {
      directory,
    });
    return loaded;
  } catch (cause: unknown) {
    logger.warn(
      'the native terminal could not be loaded, so terminals will be opened by the editor instead',
      { directory, cause }
    );
    return null;
  }
}
