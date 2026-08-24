import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_PATH_SETTING } from '../../packages/core/src/index';

/**
 * Where this extension is allowed to run, declared rather than inherited.
 *
 * `workspace`, and the reason is that everything this build does is done to the
 * folder: it opens terminals in it, spawns `claude` in it, watches the processes
 * that result and writes a store beside them. A UI extension in a remote window
 * runs on the local machine, where that folder has no path, that CLI may not be
 * installed and those processes are not visible -- so a `ui` half of this
 * product would be a window watching nothing and reporting it as calm.
 *
 * The declaration happens to agree with what VS Code assumes for an extension
 * that has a `main`, and that is the point of writing it down rather than an
 * argument against it: an assumption is not a decision, and this one changes
 * which machine somebody's agent is started on.
 *
 * **It fixes nothing about the two-store hazard, and this is the place that says
 * so.** `extensionKind` decides which extension host we land in; it says nothing
 * about which HOME that host has. A project opened locally and again in WSL is
 * two hosts with two homes and therefore two stores, neither able to see the
 * other's `owners/` -- and pinning ourselves to the workspace side makes that
 * MORE certain, not less. What answers it is `refuseSplitStore`, which stops the
 * remote window from opening a store the local one cannot see.
 *
 * The manifest is read here rather than asserted from memory for the ordinary
 * reason: a key silently dropped from `package.json` changes where a person's
 * agents run and changes nothing a normal test can see.
 */

const MANIFEST = join(__dirname, '..', '..', 'packages', 'extension', 'package.json');

interface Manifest {
  readonly main?: string;
  readonly extensionKind?: readonly string[];
  readonly contributes: {
    readonly configuration: { readonly properties: Readonly<Record<string, unknown>> };
  };
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

describe('where the extension is allowed to run', () => {
  it('says workspace, and says it rather than leaving it to a default', () => {
    expect(manifest.extensionKind).toStrictEqual(['workspace']);
  });

  it('has the entry point that makes the question real', () => {
    // A manifest with no `main` runs nothing anywhere, and `extensionKind` on
    // one would be a preference about nobody.
    expect(manifest.main).toBeDefined();
  });

  /*
   * The refusal in `refuseSplitStore` stops activation and names one way out. If
   * that key ever stopped being a setting this build contributes, the sentence
   * would be sending a person to a box that is not in their settings editor --
   * which is the same as no way out at all.
   */
  it('contributes the setting the split-store refusal tells people to set', () => {
    expect(Object.keys(manifest.contributes.configuration.properties)).toContain(
      STORAGE_PATH_SETTING
    );
  });
});
