import {
  OwnerId,
  identifyEditor,
  identifyWindow,
  ownerRefFor,
  type WindowFacts,
} from '../../packages/core/src/index';

const OWNER = OwnerId.fromString('window-activation-1');

function facts(overrides: Partial<WindowFacts> = {}): WindowFacts {
  return {
    ownerId: OWNER,
    appName: 'Visual Studio Code',
    editorVersion: '1.132.0',
    pid: 4242,
    workspaceFolders: ['D:/Projects/foo'],
    ...overrides,
  };
}

describe('identifyEditor reads the name an editor gives itself', () => {
  it('knows VS Code, including the builds that are still VS Code', () => {
    expect(identifyEditor('Visual Studio Code')).toBe('vscode');
    expect(identifyEditor('Visual Studio Code - Insiders')).toBe('vscode');
    expect(identifyEditor('Code - OSS')).toBe('vscode');
  });

  it('knows Cursor', () => {
    expect(identifyEditor('Cursor')).toBe('cursor');
  });

  it('does not care about case', () => {
    // The input is a marketing string, not an enumeration.
    expect(identifyEditor('CURSOR')).toBe('cursor');
    expect(identifyEditor('visual studio code')).toBe('vscode');
  });

  it('prefers the more specific answer when a fork names both', () => {
    expect(identifyEditor('Cursor (Visual Studio Code)')).toBe('cursor');
  });

  it('says unknown rather than falling over, and rather than guessing', () => {
    // A fork we have not measured gets a label we did not invent. It costs
    // almost nothing: `editorKind` is display, and §6 keeps it out of the
    // restore predicate precisely so that switching editors does not strand a
    // person's terminals.
    expect(identifyEditor('Windsurf')).toBe('unknown');
    expect(identifyEditor('VSCodium')).toBe('unknown');
    expect(identifyEditor('')).toBe('unknown');
  });

  it('never answers none, which belongs to an owner with no editor', () => {
    const answers = ['Visual Studio Code', 'Cursor', 'Windsurf', ''].map(identifyEditor);

    expect(answers).not.toContain('none');
  });
});

describe('identifyWindow describes this window as others will read it', () => {
  it('carries every fact the owners file holds', () => {
    expect(identifyWindow(facts())).toStrictEqual({
      ownerId: OWNER,
      kind: 'window',
      pid: 4242,
      editorKind: 'vscode',
      editorVersion: '1.132.0',
      workspaceFolders: ['D:/Projects/foo'],
    });
  });

  it('is a window, and says so in one place', () => {
    // A `service` owner is an orchestrator with no editor, which nothing in the
    // MVP produces. Fixed here so that adding the other kind is a change to one
    // function rather than a search.
    expect(identifyWindow(facts({ appName: 'Cursor' })).kind).toBe('window');
  });

  it('cannot be edited afterwards through the array it was given', () => {
    // `readonly string[]` is a promise to the compiler only: the caller keeps
    // its own array, and an identity that has been announced must not change
    // under the readers of it.
    const folders = ['D:/Projects/foo'];
    const identity = identifyWindow(facts({ workspaceFolders: folders }));

    folders.push('D:/Projects/bar');

    expect(identity.workspaceFolders).toStrictEqual(['D:/Projects/foo']);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('holds a window with no folder open', () => {
    expect(identifyWindow(facts({ workspaceFolders: [] })).workspaceFolders).toStrictEqual([]);
  });
});

describe('ownerRefFor stamps the identity into a record', () => {
  it('keeps the two owner types from disagreeing about one window', () => {
    const reference = ownerRefFor(identifyWindow(facts({ appName: 'Cursor' })));

    expect(reference.kind).toBe('window');
    expect(reference.ownerId).toBe(OWNER);
    expect(reference.editorKind).toBe('cursor');
    expect(reference.workspaceFolder).toBe('D:/Projects/foo');
  });

  it('takes the first folder, which is where this window creates terminals', () => {
    const identity = identifyWindow(facts({ workspaceFolders: ['D:/a', 'D:/b'] }));

    expect(ownerRefFor(identity).workspaceFolder).toBe('D:/a');
  });

  it('gives a window with no folders a null, not a blank', () => {
    // `null` belongs to windows with no folder open -- which is what makes such
    // a record restorable at all, rather than restorable by nobody (§6).
    const identity = identifyWindow(facts({ workspaceFolders: [] }));

    expect(ownerRefFor(identity).workspaceFolder).toBeNull();
  });
});
