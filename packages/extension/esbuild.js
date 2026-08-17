// Bundles the extension into a single CommonJS file for the VSIX, and puts the
// native pty beside it.
//
// 'vscode' stays external: it is provided by the Extension Host at runtime and
// cannot be bundled. 'node-pty' stays external for a different reason -- see
// `external` below -- and is COPIED rather than bundled, by `copyNodePty`.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Where the copy of node-pty lands: beside the bundle, inside `assets/`, which
 * already travels into the VSIX.
 *
 * `vsce` ignores `node_modules/**` in its own glob, before any `.vscodeignore` is
 * read, and does not follow pnpm's symlinks either -- so a dependency cannot
 * reach a published archive by being a dependency. A copy can (M3.12).
 */
const PTY_DESTINATION = path.join(__dirname, 'assets', 'node-pty');

/**
 * What of the package the copy takes, by top-level name.
 *
 * `lib/` is the JavaScript node-pty runs; `prebuilds/` holds the addons its
 * `lib/utils.js` looks for (`../prebuilds/<platform>-<arch>/pty.node`, read out
 * of 1.1.0); `package.json` is what makes the directory requirable at all;
 * `LICENSE` because the package is MIT and we are redistributing it, which is a
 * condition rather than a courtesy.
 *
 * What is left out is the build half of the package -- `src/`, `deps/`,
 * `third_party/`, `scripts/`, `binding.gyp`, `typings/`. An allowlist and not a
 * denylist: a new top-level directory in a later version is then a file the
 * integration run fails on, rather than something that silently doubles the
 * archive.
 */
const PTY_KEEP = ['package.json', 'LICENSE', 'lib', 'prebuilds'];

/**
 * Files inside those the copy still refuses.
 *
 * Measured 2026-08-17 rather than assumed: node-pty 1.1.0 unpacks to 62 MB, of
 * which 58 MB is `prebuilds/**\/*.pdb` -- Windows debug symbols for binaries we
 * do not debug and cannot rebuild. The plan said "the whole package", on an
 * estimate of 2.8 MB that turns out to be true of the runtime and not of the
 * package. `*.map` and `*.test.js` go for the same reason on a smaller scale.
 */
const PTY_DROP = ['.pdb', '.map', '.test.js'];

/** @type {import('esbuild').BuildOptions} */
const options = {
  // Paths resolve against the package, not against whatever directory the
  // script was invoked from — the root script calls it as `node packages/...`.
  absWorkingDir: __dirname,
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // 'node-pty' is here so that a bare `require('node-pty')` -- if one ever
  // appears -- stays a bare require in the output instead of being pulled in.
  // Pulling it in would look like it worked: esbuild cannot resolve
  // `require(dir + '/' + name + '.node')` statically, so the addon lookup would
  // survive as a runtime require resolved against `dist/`, where no `prebuilds/`
  // exists. The adapter deliberately does not use the bare name -- it requires
  // the copied directory by absolute path -- so this entry is a guard and not a
  // mechanism.
  external: ['vscode', 'node-pty'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Whether this file is one the copy keeps. Directories are always descended into. */
function wanted(source) {
  if (fs.statSync(source).isDirectory()) {
    return true;
  }
  return !PTY_DROP.some((suffix) => source.endsWith(suffix));
}

/**
 * How much is in a directory, counted by walking it.
 *
 * Written out rather than taken from `readdirSync(..., { recursive: true })`:
 * that call's `Dirent` names its own directory as `path` in Node 20 and as
 * `parentPath` from 20.12 on, and the root's `engines` says `>=20`.
 */
function measure(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inside = measure(full);
      files += inside.files;
      bytes += inside.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

/**
 * Puts node-pty where the extension can require it at runtime.
 *
 * Part of `build:extension` and not only of `package`, deliberately: the
 * integration host runs the built extension without ever packaging it, so a copy
 * made only at packaging time would leave the `own` engine unable to load its
 * addon in exactly the run that is supposed to prove it works. It would not fail
 * either -- the adapter falls back to the editor engine -- so a suite claiming to
 * cover both engines would be running one of them twice (M3.12).
 *
 * A missing package FAILS THE BUILD. The alternative is a bundle that is fine
 * until somebody selects the other engine.
 */
function copyNodePty() {
  const packageDir = path.dirname(require.resolve('node-pty/package.json'));

  fs.rmSync(PTY_DESTINATION, { recursive: true, force: true });
  fs.mkdirSync(PTY_DESTINATION, { recursive: true });
  for (const entry of PTY_KEEP) {
    fs.cpSync(path.join(packageDir, entry), path.join(PTY_DESTINATION, entry), {
      recursive: true,
      filter: wanted,
    });
  }

  // Printed rather than trusted: this is a size a person is entitled to know
  // about before it is in their editor, and the number moves with the version.
  const copied = measure(PTY_DESTINATION);
  const megabytes = (copied.bytes / (1024 * 1024)).toFixed(1);
  console.log(`node-pty: ${String(copied.files)} files, ${megabytes} MB copied from ${packageDir}`);
}

async function main() {
  copyNodePty();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }
  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
