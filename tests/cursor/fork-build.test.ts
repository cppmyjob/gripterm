import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `tools/fork-build.js`: which BUILD of which editor answered.
 *
 * **The defect this exists for, and it is in this repository's own records.**
 * `gate/allowed-red.json` explains point 4 with a sentence "read out of the
 * Cursor 3.17.8 bundle"; the stand's recordings say `editor: "Cursor.exe"` and
 * nothing else; and the Cursor on this machine is 3.17.19, published two days
 * after that sentence was written. So every measurement this repository holds
 * about the fork is attributed to a build nobody can name from the file it is
 * written in, and two measurements that disagree cannot be told apart from one
 * measurement that moved. A fork ships every few days and its workbench is
 * exactly what these measurements are ABOUT.
 *
 * **Neutral by construction.** What comes back is copied out of the editor's own
 * `product.json` and nothing else: no path, no machine, no user. A recording is
 * a file that gets committed, pasted into a report and sent to somebody, and
 * `tests/stand/no-machine-in-the-record.test.ts` holds that line over the
 * recordings. This holds it over the record before it is written.
 */

const TOOL = join(__dirname, '..', '..', 'tools', 'fork-build.js');

interface Product {
  readonly nameLong?: string;
  readonly version?: string;
  readonly commit?: string;
  readonly date?: string;
  readonly vscodeVersion?: string;
}

/** An editor tree with `product.json` at `depth` directories below the executable. */
function editorTree(product: Product | null, depth: 0 | 1): { exe: string, root: string } {
  const root = mkdtempSync(join(tmpdir(), 'gripterm-fork-'));
  const exe = join(root, 'Whatever.exe');
  writeFileSync(exe, 'not really an executable', 'utf8');
  if (product !== null) {
    const app = depth === 0 ? join(root, 'resources', 'app') : join(root, 'abc123', 'resources', 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'product.json'), JSON.stringify(product), 'utf8');
  }
  return { exe, root };
}

function forkBuild(exe: string): unknown {
  const out = execFileSync(process.execPath, [TOOL, exe], { encoding: 'utf8' });
  return JSON.parse(out) as unknown;
}

function refusal(exe: string): string {
  try {
    execFileSync(process.execPath, [TOOL, exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (failed) {
    return (failed as { stderr?: string }).stderr ?? '';
  }
  throw new Error('the tool answered where it was expected to refuse');
}

describe('the build of the editor that answered', () => {
  it('names the fork, its own version and the VS Code it is a fork of', () => {
    const { exe, root } = editorTree(
      {
        nameLong: 'Cursor',
        version: '3.17.19',
        commit: 'ae3a2b7231dd56194447fe4570dfdc61640b1e90',
        date: '2026-08-24T06:42:14.583Z',
        vscodeVersion: '1.128.0',
      },
      0
    );
    try {
      expect(forkBuild(exe)).toEqual({
        editor: 'Cursor',
        version: '3.17.19',
        vscodeVersion: '1.128.0',
        commit: 'ae3a2b7231dd56194447fe4570dfdc61640b1e90',
        built: '2026-08-24T06:42:14.583Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says `null` for the VS Code version of something that IS VS Code', () => {
    // Measured 2026-08-25: the stable 1.134.0 product.json has no
    // `vscodeVersion` at all, and Cursor's has one. The absence is the fact --
    // reporting the editor's own version there instead would make a fork and
    // its upstream indistinguishable in the very record that exists to tell
    // them apart.
    const { exe, root } = editorTree(
      { nameLong: 'Visual Studio Code', version: '1.134.0', commit: '110a328ea5', date: '2026-08-18T18:24:44Z' },
      0
    );
    try {
      expect(forkBuild(exe)).toEqual({
        editor: 'Visual Studio Code',
        version: '1.134.0',
        vscodeVersion: null,
        commit: '110a328ea5',
        built: '2026-08-18T18:24:44Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds the product one directory below the executable, which is where a downloaded VS Code keeps it', () => {
    // Measured 2026-08-25 on `.vscode-test/vscode-win32-x64-archive-1.134.0`:
    // `Code.exe` sits at the top and `resources/app` sits under a directory
    // named after the commit. An editor this cannot read is an editor whose
    // build goes unrecorded, which is the whole defect.
    const { exe, root } = editorTree({ nameLong: 'Visual Studio Code', version: '1.134.0', commit: 'abc', date: 'then' }, 1);
    try {
      expect(forkBuild(exe)).toMatchObject({ editor: 'Visual Studio Code', version: '1.134.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an editor whose product says no version, rather than recording `undefined` as the build', () => {
    const { exe, root } = editorTree({ nameLong: 'Cursor' }, 0);
    try {
      expect(refusal(exe)).toContain('no `version`');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses where there is no product at all, naming both places it looked', () => {
    const { exe, root } = editorTree(null, 0);
    try {
      const said = refusal(exe);
      expect(said).toContain('resources');
      expect(said).toContain('product.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries no path, no machine and no user into the record', () => {
    const { exe, root } = editorTree({ nameLong: 'Cursor', version: '3.17.19', commit: 'c', date: 'd', vscodeVersion: '1.128.0' }, 0);
    try {
      const written = JSON.stringify(forkBuild(exe));
      expect(written).not.toContain(root);
      expect(written.toLowerCase()).not.toContain('.exe');
      expect(written.toLowerCase()).not.toContain('users');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
