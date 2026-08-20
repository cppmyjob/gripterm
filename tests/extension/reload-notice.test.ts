import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigurationChangeEvent } from 'vscode';
import {
  READ_ONCE_SETTINGS,
  noticeFor,
  reloadNotices,
} from '../../packages/extension/src/ui/reload-notice';

/**
 * What a window says when somebody changes a setting it has already read.
 *
 * The subject is silence. Every setting of this build is read once, at
 * activation, so an edit made under a running window does nothing whatever --
 * and "did nothing" and "took effect and did not work" are the same picture from
 * the person's chair. M3.13 asks for the engine to be answered at the moment of
 * the change; the storage path was already answered that way, and the other
 * seven were answered by nothing at all.
 *
 * Two of the tests below are the reconciliation between this list and the
 * manifest, in both directions. That is what makes the promise the manifest makes --
 * "Takes effect when the window reloads" -- a thing a run can check rather than
 * a thing somebody remembers to keep true.
 *
 * A fake event rather than the editor's: `ConfigurationChangeEvent` is one
 * method, the rule calls it and nothing else, and a real host would add a minute
 * to the run to tell us what a two-line object tells us here.
 */

const MANIFEST = join(__dirname, '..', '..', 'packages', 'extension', 'package.json');

/** The promise the manifest makes to the person, word for word. */
const RELOAD_PROMISE = 'Takes effect when the window reloads';

interface Manifest {
  readonly contributes: {
    readonly configuration: {
      readonly properties: Readonly<Record<string, { readonly markdownDescription?: string, readonly description?: string }>>;
    };
  };
}

function settingsInTheManifest(): Readonly<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const described: Record<string, string> = {};
  for (const [setting, property] of Object.entries(manifest.contributes.configuration.properties)) {
    described[setting] = property.markdownDescription ?? property.description ?? '';
  }
  return described;
}

/** An event that answers for exactly the sections named, as the editor's does for a section. */
function changed(...sections: readonly string[]): ConfigurationChangeEvent {
  return {
    affectsConfiguration: (section: string) => sections.includes(section),
  };
}

describe('what is said when a setting that is read once changes', () => {
  it('answers a change of the terminal engine with the reload it needs', () => {
    expect(reloadNotices(changed('gripterm.terminal.engine'))).toEqual([
      'Gripterm reads which engine makes a terminal once, when the window loads. Reload the window for the change to take effect.',
    ]);
  });

  it('answers a change of the storage path with the reload it needs', () => {
    expect(reloadNotices(changed('gripterm.storage.path'))).toEqual([
      'Gripterm reads its storage path once, when the window loads. Reload the window for the change to take effect.',
    ]);
  });

  it('answers every one of them when one edit moved several, because the event carries no order', () => {
    expect(
      reloadNotices(changed('gripterm.storage.path', 'gripterm.terminal.engine', 'gripterm.launch.mode'))
    ).toHaveLength(3);
  });

  it('says nothing about settings that are not ours', () => {
    expect(reloadNotices(changed('terminal.integrated.fontFamily'))).toEqual([]);
    expect(reloadNotices(changed('editor.fontSize'))).toEqual([]);
  });

  /*
   * The sentence is what a person reads at the moment they wonder why nothing
   * happened. One that said "reload" without saying WHAT was read once would
   * send them looking in the wrong place, so every one of them names its own
   * subject -- and no two of them name the same one.
   */
  it('names, in every sentence, what was read once and what to do about it', () => {
    const sentences = READ_ONCE_SETTINGS.map(noticeFor);
    for (const sentence of sentences) {
      expect(sentence).toContain('once, when the window loads');
      expect(sentence).toContain('Reload the window');
    }
    expect(new Set(sentences).size).toBe(READ_ONCE_SETTINGS.length);
  });
});

/*
 * The two directions of the same agreement. A setting can drift out of it in
 * either -- a new key in the manifest that nothing announces, or a key here that
 * the manifest never promises a reload for -- and the two failures read
 * differently, which is why they are two tests and not one set comparison.
 */
describe('the manifest and the sentences say the same thing', () => {
  // Named rather than counted, in both directions: a run that says "2 !== 3" is
  // a run somebody has to go and diff by hand.
  it('promises a reload for every setting this build reads once', () => {
    const described = settingsInTheManifest();
    const silent = READ_ONCE_SETTINGS.filter(
      (known) => !(described[known.setting] ?? '').includes(RELOAD_PROMISE)
    ).map((known) => known.setting);
    // Either the manifest never mentions the key, or its description does not
    // tell the person that the change waits for a reload. Both leave somebody
    // editing a setting that does nothing.
    expect(silent).toEqual([]);
  });

  it('reads once every setting the manifest promises a reload for', () => {
    const announced = new Set(READ_ONCE_SETTINGS.map((known) => known.setting));
    const unannounced = Object.entries(settingsInTheManifest())
      .filter(([setting, description]) => description.includes(RELOAD_PROMISE) && !announced.has(setting))
      .map(([setting]) => setting);
    // Add it to READ_ONCE_SETTINGS -- or, if the setting is now read live, take
    // the promise out of the manifest, because it has stopped being true.
    expect(unannounced).toEqual([]);
  });

  /*
   * And the whole surface, because today the answer is all of them: this build
   * composes itself once and reads nothing again. If that ever stops being true,
   * this is the test that says which setting changed sides.
   */
  it('accounts for every setting the extension contributes', () => {
    const announced = new Set(READ_ONCE_SETTINGS.map((known) => known.setting));
    expect(new Set(Object.keys(settingsInTheManifest()))).toEqual(announced);
  });
});
