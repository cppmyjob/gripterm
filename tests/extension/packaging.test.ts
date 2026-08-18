import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');
const EXTENSION_DIR = join(REPO, 'packages', 'extension');

/** The node-pty this build installed, which is what the copy in the archive is copied FROM. */
const PTY_PACKAGE = join(EXTENSION_DIR, 'node_modules', 'node-pty');

/** Where the copy lands, and where the archive carries it. */
const PTY_IN_ARCHIVE = 'assets/node-pty';

/** `vsce` starting up is slow, and this asks it exactly once. */
const TIMEOUT_MS = 120_000;

/** Short of this, a file called `LICENSE.txt` is a stub rather than a licence. The text is 11 KB. */
const WHOLE_LICENCE_BYTES = 10_000;

/**
 * What would go into the VSIX, according to the tool that builds it.
 *
 * `vsce ls` applies `.vscodeignore` and prints the file list without packaging
 * anything, so this asks the real rules rather than re-implementing them.
 */
async function packagedFiles(): Promise<readonly string[]> {
  return await new Promise<readonly string[]>((resolve, reject) => {
    execFile(
      'npx',
      ['vsce', 'ls', '--no-dependencies'],
      { cwd: EXTENSION_DIR, shell: true, timeout: TIMEOUT_MS },
      (error: unknown, stdout: string) => {
        if (error !== null) {
          reject(new Error('vsce ls could not list the package contents', { cause: error }));
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim().replaceAll('\\', '/'))
            .filter((line) => line.length > 0)
        );
      }
    );
  });
}

/** Every file under a directory, as paths relative to it, `/` separated. Empty when there is no directory. */
function filesUnder(root: string, prefix = ''): readonly string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return statSync(join(root, entry.name)).isDirectory()
      ? filesUnder(join(root, entry.name), relative)
      : [relative];
  });
}

/**
 * What the archive must carry out of node-pty, stated against the INSTALLED
 * package rather than against a list in this file.
 *
 * The plan's own instruction, and the reason for it: the composition of the
 * package moves with its version, so a list written here would go stale in
 * silence -- a new runtime file in a later version would be missing from the copy
 * AND from the expectation, and the archive would be short of a file the loader
 * asks for with nothing red. Pinning the version is what makes that rare; reading
 * the package is what makes it visible.
 *
 * Three subtractions, and each one is a promise of this step rather than a
 * restatement of the copy filter:
 *
 *   * the package's own tests, which nothing requires;
 *   * debug symbols -- 58 MB of them, for binaries we neither debug nor rebuild
 *     (measured M3.4-B);
 *   * the `conpty` directory of each Windows platform: `conpty.dll` and
 *     `OpenConsole.exe`, 2.5 MB between them, loaded by `conpty.node` only when
 *     `useConptyDll: true` is passed in. Nothing in this build passes it
 *     (owner's decision 2026-08-18), so they would be dead weight in every
 *     install. THIS ASSERTION IS THE DEADLINE ON THAT DECISION: switching the
 *     flag on turns this test red, which is the only reason it can be switched on
 *     without the archive quietly staying short of what the native code then
 *     tries to load.
 *
 * Declaration and sourcemap files need no subtraction of their own: `.vscodeignore`
 * strips both from the archive, and the filter below keeps only JavaScript out of
 * `lib/`.
 */
function fromNodePty(): readonly string[] {
  const installed = filesUnder(PTY_PACKAGE);
  if (installed.length === 0) {
    throw new Error(
      `no node-pty in ${PTY_PACKAGE} -- run \`pnpm install\`. The copy in the archive is checked ` +
      'against the installed package, and there is nothing here to check it against.'
    );
  }
  const runtime = installed.filter((file) => {
    if (file === 'package.json' || file === 'LICENSE') {
      return true;
    }
    if (file.startsWith('lib/')) {
      return file.endsWith('.js') && !file.endsWith('.test.js');
    }
    if (file.startsWith('prebuilds/')) {
      return !file.endsWith('.pdb') && !file.includes('/conpty/');
    }
    // `src/`, `deps/`, `third_party/`, `scripts/`, `binding.gyp`, `typings/`:
    // the build half of the package, which no install of ours ever reads.
    return false;
  });
  return runtime.map((file) => `${PTY_IN_ARCHIVE}/${file}`);
}

/**
 * The files that are in the repository and have to reach a person's editor.
 *
 * Spelled out because every one of them is a decision rather than a build
 * product, and a list is what makes a deletion loud.
 */
const OURS: readonly string[] = [
  'package.json',
  /*
   * Apache-2.0 section 4(a): a copy of the licence travels with the
   * distribution. The manifest and NOTICE.md have claimed the licence since
   * M3.6; until 2026-08-18 the archive carried neither the text nor a way to
   * ask for it.
   *
   * `.txt` and not the bare `LICENSE` a repository usually carries, because
   * `vsce` RENAMES it: a licence file with no extension has `.txt` appended as
   * it enters the archive (`LicenseProcessor.onFile`, `@vscode/vsce` 3.2), while
   * `vsce ls` goes on printing the source name. Named `LICENSE.txt` here, the
   * file this test sees, the entry in the .vsix and the file the editor unpacks
   * are all one name. It was the installed run that found this -- nothing
   * readable from `vsce ls` can.
   */
  'LICENSE.txt',
  // The attribution under which the codicon font (CC-BY-4.0) and node-pty and
  // xterm.js (MIT) are redistributed. A condition, not a courtesy.
  'NOTICE.md',
  'media/panel.svg',
  /*
   * `SessionStart` is the single event the CLI will not deliver over HTTP, so it
   * travels through a script we ship. A packaging rule that excluded that script
   * would cost every terminal that event -- and cost it SILENTLY, because a
   * failed hook is non-blocking: the CLI would carry on, and the only symptom
   * would be a conversation renamed by `/clear` that we never noticed.
   */
  'assets/gripterm-forwarder.js',
];

/** The font the page draws its state icons with. Its name carries the content hash esbuild gave it. */
const FONT = /^dist\/webview\/codicon-[^/]+\.ttf$/u;

/**
 * What the build put in `dist/`, minus what `.vscodeignore` strips from it.
 *
 * Read off the disk rather than listed, so that the reconciliation stays exact on
 * a tree where nothing has been built: `dist/` is then empty, the archive carries
 * nothing from it, and the last test in this suite is what says so out loud. What
 * guards the page's own completeness is the build itself
 * (`refuseAnIncompletePage`), which throws where the gap was made.
 */
function fromDist(): readonly string[] {
  return filesUnder(join(EXTENSION_DIR, 'dist'))
    .filter((file) => !file.endsWith('.map') && !file.endsWith('.ts'))
    .map((file) => `dist/${file}`);
}

/**
 * The archive, reconciled file by file rather than sampled by name.
 *
 * Until M3.12 this suite named three files and asked whether they were there,
 * which cannot see either of the two failures that matter: something MISSING that
 * no name here happens to mention, and something EXTRA -- a debug symbol, a
 * sourcemap, somebody's sources -- that nobody meant to publish. Both are silent,
 * and both ride to every person who installs the extension.
 */
describe('what goes into the VSIX', () => {
  let files: readonly string[] = [];

  beforeAll(async () => {
    files = await packagedFiles();
  }, TIMEOUT_MS);

  it('carries exactly the files this build means to publish, and nothing else', () => {
    const expected = new Set([...OURS, ...fromDist(), ...fromNodePty()]);
    const missing = [...expected].filter((file) => !files.includes(file));
    // The font is the one name nobody can write down: esbuild puts a content
    // hash in it. It is asserted separately, below.
    const extra = files.filter((file) => !expected.has(file) && !FONT.test(file));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('carries one icon font, whatever hash the build gave it', () => {
    expect(files.filter((file) => FONT.test(file))).toHaveLength(1);
  });

  it('carries every runtime piece node-pty asks for, by name', () => {
    /*
     * The list the plan wrote out, and it stays a list on purpose: the
     * reconciliation above is derived from the installed package, so a copy
     * filter and an expectation that were wrong in the SAME way would agree with
     * each other. These are the files whose absence has been traced to a failure
     * -- the addon itself, the console-list agent `windowsPtyAgent.js` forks, the
     * worker `conout.js` runs -- and each is named here so that the archive is
     * checked against what node-pty reads rather than against what the copy
     * happened to take.
     */
    const asked = [
      'package.json',
      'LICENSE',
      'lib/index.js',
      'lib/utils.js',
      'lib/terminal.js',
      'lib/windowsTerminal.js',
      'lib/windowsPtyAgent.js',
      'lib/windowsConoutConnection.js',
      'lib/conpty_console_list_agent.js',
      'lib/worker/conoutSocketWorker.js',
      'lib/shared/conout.js',
      'prebuilds/win32-x64/pty.node',
      'prebuilds/win32-x64/conpty.node',
      'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/winpty.dll',
      'prebuilds/win32-x64/winpty-agent.exe',
    ].map((file) => `${PTY_IN_ARCHIVE}/${file}`);

    expect(asked.filter((file) => !files.includes(file))).toEqual([]);
  });

  it('carries the whole text of the licence it claims, and not a line naming it', () => {
    /*
     * A file called `LICENSE.txt` satisfies the reconciliation above whatever is
     * in it, and an empty one satisfies nothing else: Apache-2.0 section 4(a)
     * asks for the licence, not for its name. Read off the disk because the
     * archive carries this very file -- `vsce ls` says which files travel and
     * nothing about what is in them.
     */
    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'package.json'), 'utf8')) as { license: string };
    const text = readFileSync(join(EXTENSION_DIR, 'LICENSE.txt'), 'utf8');

    expect(manifest.license).toBe('Apache-2.0');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0');
    // The licence is 11 KB; anything an order of magnitude short of that is a
    // stub, whatever it is called.
    expect(text.length).toBeGreaterThan(WHOLE_LICENCE_BYTES);
  });

  it('leaves out everything that must never be published', () => {
    const refused = [
      ['a source file', (file: string) => file.startsWith('src/') || file.endsWith('.ts')],
      ['a sourcemap', (file: string) => file.endsWith('.map')],
      ['a debug symbol', (file: string) => file.endsWith('.pdb')],
      ['a test of the package we copied', (file: string) => file.endsWith('.test.js')],
      ['a node_modules tree', (file: string) => file.includes('node_modules/')],
      // The 2.5 MB `useConptyDll` needs and this build does not. See `fromNodePty`.
      ['an unused conpty dll', (file: string) => file.includes('/conpty/')],
    ] as const;

    const found = refused.flatMap(([what, matches]) =>
      files.filter(matches).map((file) => `${what}: ${file}`)
    );
    expect(found).toEqual([]);
  });

  it('was listed against a real build, and refuses to be read as a check when it was not', () => {
    /*
     * The reconciliation is exact either way, but it is only INTERESTING when
     * there is something to reconcile: on a tree where nothing has been built,
     * `dist/` is empty and the archive is a manifest and a licence. This is where
     * a green suite stops being readable as a checked archive.
     */
    if (!existsSync(join(EXTENSION_DIR, 'dist', 'extension.js'))) {
      throw new Error(
        'no dist/extension.js -- run `pnpm run build && pnpm run build:extension` first. ' +
        'The archive was listed without a bundle in it, so nothing about what is published was checked.'
      );
    }
    expect(files).toContain('dist/extension.js');
  });
});
