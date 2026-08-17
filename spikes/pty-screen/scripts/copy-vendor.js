/**
 * Copies the xterm bundles into `media/vendor/` so the webview can load them.
 *
 * Two reasons this is a copy and not a path into node_modules:
 *   * pnpm's node_modules is a farm of symlinks, and `localResourceRoots` plus
 *     `asWebviewUri` are about real directories;
 *   * it is the same move M3.12 has to make for node-pty itself, for the same
 *     underlying reason -- what ships is what was copied, not what was resolved.
 *
 * The copies are not committed (see .gitignore); `pnpm build` recreates them.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'media', 'vendor');

const WANTED = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-unicode11/lib/addon-unicode11.js', 'addon-unicode11.js'],
];

fs.mkdirSync(OUT, { recursive: true });

for (const [request, name] of WANTED) {
  const packageName = request.split('/').slice(0, 2).join('/');
  const inside = request.split('/').slice(2).join('/');
  const packageDir = path.dirname(require.resolve(`${packageName}/package.json`));
  const from = path.join(packageDir, inside);
  const to = path.join(OUT, name);
  fs.copyFileSync(from, to);
  console.log(`${name} <- ${from} (${String(fs.statSync(to).size)} bytes)`);
}
