import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_CLI_VERSION } from '../../packages/core/src/index';

/**
 * The README against the build it describes.
 *
 * M3.13 asks for one thing of the documents: no place where they say otherwise
 * than the code. The plan and the roadmap are read by us; the README is read by
 * whoever installs this, and it is the only document that promises a version, a
 * default and a command. Every one of those is a number or a name that lives
 * somewhere else too, so every one of them can go stale in silence -- and a
 * stale README is not a cosmetic defect: it is somebody pinning the wrong CLI,
 * or expecting a terminal in a place this build does not open one.
 *
 * So the numbers are read from the README and compared with their sources
 * rather than admired. What this does NOT do is check the prose: whether the
 * description is a good one is not a thing a run can answer, and pretending
 * otherwise would only teach people to phrase around the test.
 */

const REPO = join(__dirname, '..', '..');
const README = readFileSync(join(REPO, 'README.md'), 'utf8');
const EXTENSION = join(REPO, 'packages', 'extension');

interface Manifest {
  readonly engines: Readonly<Record<string, string>>;
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly configuration: { readonly properties: Readonly<Record<string, { readonly default?: unknown }>> };
  };
}

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8')) as Manifest;
const scripts = (
  JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { readonly scripts: Readonly<Record<string, string>> }
).scripts;

/** What the README says, or a failure that names the line it could not find. */
function stated(what: string, pattern: RegExp): string {
  const found = pattern.exec(README);
  if (found?.[1] === undefined) {
    throw new Error(`the README no longer states ${what} in a form this test can read (${String(pattern)})`);
  }
  return found[1];
}

describe('the README and the build agree', () => {
  it('pins the CLI version the code pins', () => {
    expect(stated('the supported CLI version', /\| Claude Code CLI \| \*\*([\d.]+)\*\*/u)).toBe(
      SUPPORTED_CLI_VERSION
    );
  });

  it('asks for the editor version the manifest asks for', () => {
    // `^1.94.0` and "1.94 or newer" are the same requirement said twice.
    expect(manifest.engines.vscode).toBe(`^${stated('the editor version', /\| VS Code \| ([\d.]+) or newer/u)}.0`);
  });

  it('names the engine that is really the default', () => {
    expect(stated('the default engine', /the default is \*\*`([a-z]+)`\*\*/u)).toBe(
      manifest.contributes.configuration.properties['gripterm.terminal.engine']?.default
    );
  });

  /*
   * The scrollback is read out of the source rather than out of a constant this
   * test could import: it lives in `workbench-view.ts`, which imports the editor
   * API and cannot be loaded by plain `jest` at all. A rename breaks this with
   * the sentence below rather than by quietly matching nothing.
   */
  it('states the history depth the page is really given', () => {
    const source = readFileSync(join(EXTENSION, 'src', 'ui', 'workbench-view.ts'), 'utf8');
    const declared = /const SCROLLBACK_LINES = (\d+);/u.exec(source);
    if (declared?.[1] === undefined) {
      throw new Error('SCROLLBACK_LINES is no longer declared in workbench-view.ts under that name');
    }
    expect(stated('the history depth', /\| (\d+) lines, and less if the panel/u)).toBe(declared[1]);
  });

  it('names only settings and commands this build contributes', () => {
    const known = new Set([
      ...Object.keys(manifest.contributes.configuration.properties),
      ...manifest.contributes.commands.map((command) => command.command),
    ]);
    const named = [...README.matchAll(/`(gripterm\.[A-Za-z.]+)`/gu)].map((found) => found[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => name !== undefined && !known.has(name))).toEqual([]);
  });

  it('names only commands that can be run', () => {
    // `pnpm install` is pnpm's own; everything else has to be in the root
    // manifest, or the reader gets "command not found" as their first move.
    const invoked = [...README.matchAll(/^pnpm ([\w:]+)/gmu)].map((found) => found[1]);
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked.filter((name) => name !== undefined && name !== 'install' && !(name in scripts))).toEqual([]);
  });

  it('names licence files that exist', () => {
    const named = [...README.matchAll(/`(LICENSE[\w.]*|NOTICE[\w.]*)`/gu)].map((found) => found[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => name !== undefined && !existsSync(join(EXTENSION, name)))).toEqual([]);
  });
});
