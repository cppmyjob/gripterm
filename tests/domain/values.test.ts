import {
  ContextWindowSnapshot,
  CostSnapshot,
  HumanMetadata,
  LaunchRecipe,
  Note,
  ObservedState,
  OwnerId,
  OwnerRef,
  PERMISSION_MODES,
  ValidationError,
  isPermissionMode,
} from '../../packages/core/src/index.js';
import { CREATED_AT, OBSERVED_AT, makeOwnerRef } from '../helpers/domain-fixtures.js';

describe('Note', () => {
  it('trims its text and refuses to be empty', () => {
    expect(Note.create(CREATED_AT, '  read ADR-014  ').text).toBe('read ADR-014');
    expect(() => Note.create(CREATED_AT, '   ')).toThrow(ValidationError);
  });

  it('refuses an invalid timestamp', () => {
    expect(() => Note.create(new Date('not a date'), 'text')).toThrow(ValidationError);
  });

  it('does not share the Date it was given', () => {
    const at = new Date(CREATED_AT.getTime());
    const note = Note.create(at, 'text');

    at.setTime(0);

    expect(note.at.getTime()).toBe(CREATED_AT.getTime());
  });

  it('does not share the Date it hands out either', () => {
    const note = Note.create(CREATED_AT, 'text');

    note.at.setTime(0);

    expect(note.at.getTime()).toBe(CREATED_AT.getTime());
  });

  it('compares by timestamp and text, and is frozen', () => {
    const note = Note.create(CREATED_AT, 'text');

    expect(note.equals(Note.create(CREATED_AT, 'text'))).toBe(true);
    expect(note.equals(Note.create(CREATED_AT, 'other'))).toBe(false);
    expect(note.equals(Note.create(OBSERVED_AT, 'text'))).toBe(false);
    expect(Object.isFrozen(note)).toBe(true);
  });
});

describe('HumanMetadata', () => {
  const base = {
    displayName: 'auth-refactor',
    task: null,
    notes: [],
    tags: [],
    color: null,
  } as const;

  it('trims the display name and refuses a blank one', () => {
    expect(HumanMetadata.create({ ...base, displayName: '  named  ' }).displayName).toBe('named');
    expect(() => HumanMetadata.create({ ...base, displayName: '  ' })).toThrow(ValidationError);
  });

  it('refuses a blank tag and drops a repeated one', () => {
    expect(() => HumanMetadata.create({ ...base, tags: ['ok', ' '] })).toThrow(ValidationError);
    expect(HumanMetadata.create({ ...base, tags: ['a', ' a ', 'b'] }).tags).toStrictEqual(['a', 'b']);
  });

  it('copies the arrays it was given, so a later push cannot reach inside', () => {
    const tags = ['backend'];
    const notes = [Note.create(CREATED_AT, 'first')];
    const metadata = HumanMetadata.create({ ...base, tags, notes });

    tags.push('leaked');
    notes.push(Note.create(CREATED_AT, 'leaked'));

    expect(metadata.tags).toStrictEqual(['backend']);
    expect(metadata.notes).toHaveLength(1);
  });

  it('freezes those arrays, so a push through the object fails loudly', () => {
    const metadata = HumanMetadata.create({ ...base, tags: ['backend'] });

    expect(() => (metadata.tags as string[]).push('x')).toThrow(TypeError);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('compares by value, notes included', () => {
    const one = HumanMetadata.create({ ...base, tags: ['a'], notes: [Note.create(CREATED_AT, 'n')] });
    const same = HumanMetadata.create({ ...base, tags: ['a'], notes: [Note.create(CREATED_AT, 'n')] });
    const other = HumanMetadata.create({ ...base, tags: ['a'], notes: [Note.create(CREATED_AT, 'm')] });

    expect(one.equals(same)).toBe(true);
    expect(one.equals(other)).toBe(false);
    expect(one.equals(HumanMetadata.create({ ...base, tags: ['a', 'b'] }))).toBe(false);
  });
});

describe('PermissionMode', () => {
  it('has exactly the six values the CLI accepts', () => {
    expect(PERMISSION_MODES).toStrictEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]);
  });

  it('does not include "default"', () => {
    // Measured on build 2.1.225: an unknown value makes the CLI exit at
    // startup, so a recipe carrying "default" would fail every launch before a
    // single hook event. Absence of a mode is `null`.
    expect(isPermissionMode('default')).toBe(false);
    expect(isPermissionMode('plan')).toBe(true);
  });
});

describe('LaunchRecipe', () => {
  const base = {
    cwd: 'D:/Projects/foo',
    addDirs: [],
    permissionMode: null,
    agent: null,
    model: null,
    worktree: null,
    mcpConfigPaths: [],
    appendSystemPrompt: null,
    extraEnv: {},
  } as const;

  it('trims cwd and refuses a blank one', () => {
    expect(LaunchRecipe.create({ ...base, cwd: ' D:/x ' }).cwd).toBe('D:/x');
    expect(() => LaunchRecipe.create({ ...base, cwd: '   ' })).toThrow(ValidationError);
  });

  it('refuses a blank path in either list', () => {
    expect(() => LaunchRecipe.create({ ...base, addDirs: [''] })).toThrow(ValidationError);
    expect(() => LaunchRecipe.create({ ...base, mcpConfigPaths: [' '] })).toThrow(ValidationError);
  });

  it('copies and freezes the lists and the environment', () => {
    const addDirs = ['D:/Projects/bar'];
    const extraEnv = { GRIPTERM_TERMINAL_ID: 'x' };
    const recipe = LaunchRecipe.create({ ...base, addDirs, extraEnv });

    addDirs.push('leaked');
    extraEnv.GRIPTERM_TERMINAL_ID = 'mutated';

    expect(recipe.addDirs).toStrictEqual(['D:/Projects/bar']);
    expect(recipe.extraEnv.GRIPTERM_TERMINAL_ID).toBe('x');
    expect(() => (recipe.addDirs as string[]).push('x')).toThrow(TypeError);
    expect(Object.isFrozen(recipe)).toBe(true);
  });

  it('keeps the whole recipe, because --resume restores none of it', () => {
    const recipe = LaunchRecipe.create({
      ...base,
      permissionMode: 'plan',
      model: 'opus',
      mcpConfigPaths: ['D:/bus.json'],
      appendSystemPrompt: 'You are terminal auth-refactor',
    });

    expect(recipe.permissionMode).toBe('plan');
    expect(recipe.model).toBe('opus');
    expect(recipe.mcpConfigPaths).toStrictEqual(['D:/bus.json']);
    expect(recipe.appendSystemPrompt).toBe('You are terminal auth-refactor');
  });
});

describe('CostSnapshot', () => {
  it('accepts a real reading', () => {
    const cost = CostSnapshot.create(0.42, 913000);

    expect(cost.totalUsd).toBe(0.42);
    expect(cost.durationMs).toBe(913000);
    expect(cost.equals(CostSnapshot.create(0.42, 913000))).toBe(true);
    expect(cost.equals(CostSnapshot.create(0.43, 913000))).toBe(false);
    expect(Object.isFrozen(cost)).toBe(true);
  });

  it.each([
    ['a negative cost', -1, 0],
    ['a negative duration', 0, -1],
    ['NaN', Number.NaN, 0],
    ['Infinity', Number.POSITIVE_INFINITY, 0],
  ])('refuses %s', (_label, totalUsd, durationMs) => {
    expect(() => CostSnapshot.create(totalUsd, durationMs)).toThrow(ValidationError);
  });
});

describe('ContextWindowSnapshot', () => {
  it('accepts a percentage', () => {
    expect(ContextWindowSnapshot.create(37.2).usedPercentage).toBe(37.2);
  });

  it('accepts a value above one hundred, deliberately', () => {
    // The CLI reports `used_percentage` and also publishes an
    // `exceeds_200k_tokens` flag, so above-100 is a thing that can be said.
    // Throwing here would turn a display detail into a failure on the ingest
    // path.
    expect(ContextWindowSnapshot.create(140).usedPercentage).toBe(140);
  });

  it('refuses a negative or non-finite percentage', () => {
    expect(() => ContextWindowSnapshot.create(-1)).toThrow(ValidationError);
    expect(() => ContextWindowSnapshot.create(Number.NaN)).toThrow(ValidationError);
  });

  it('compares by value and is frozen', () => {
    const snapshot = ContextWindowSnapshot.create(37.2);

    expect(snapshot.equals(ContextWindowSnapshot.create(37.2))).toBe(true);
    expect(snapshot.equals(ContextWindowSnapshot.create(37.3))).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe('ObservedState', () => {
  const base = {
    state: 'idle',
    lastEventAt: OBSERVED_AT,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  } as const;

  it('refuses an invalid timestamp', () => {
    expect(() => ObservedState.create({ ...base, lastEventAt: new Date('nope') })).toThrow(
      ValidationError
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a pid that is %s', (_label, pid) => {
    expect(() => ObservedState.create({ ...base, pid })).toThrow(ValidationError);
  });

  it('allows a null pid: a terminal we have not seen start has none', () => {
    expect(ObservedState.create({ ...base, pid: null }).pid).toBeNull();
    expect(ObservedState.create({ ...base, pid: 21344 }).pid).toBe(21344);
  });

  it('does not share its Date in either direction, and is frozen', () => {
    const lastEventAt = new Date(OBSERVED_AT.getTime());
    const observed = ObservedState.create({ ...base, lastEventAt });

    lastEventAt.setTime(0);
    observed.lastEventAt.setTime(0);

    expect(observed.lastEventAt.getTime()).toBe(OBSERVED_AT.getTime());
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('carries the two readings only the statusline can supply', () => {
    const observed = ObservedState.create({
      ...base,
      cost: CostSnapshot.create(0.42, 913000),
      contextWindow: ContextWindowSnapshot.create(37.2),
    });

    expect(observed.cost?.totalUsd).toBe(0.42);
    expect(observed.contextWindow?.usedPercentage).toBe(37.2);
  });
});

describe('OwnerRef', () => {
  it('accepts a folder or none, but never a blank one', () => {
    expect(makeOwnerRef().workspaceFolder).toBe('D:/Projects/foo');
    expect(
      OwnerRef.create({
        kind: 'window',
        ownerId: OwnerId.fromString('a'),
        editorKind: 'none',
        workspaceFolder: null,
      }).workspaceFolder
    ).toBeNull();
    expect(() =>
      OwnerRef.create({
        kind: 'window',
        ownerId: OwnerId.fromString('a'),
        editorKind: 'vscode',
        workspaceFolder: '  ',
      })
    ).toThrow(ValidationError);
  });

  it('compares on all four fields, and is frozen', () => {
    const owner = makeOwnerRef();

    expect(owner.equals(makeOwnerRef())).toBe(true);
    expect(owner.equals(makeOwnerRef('window-activation-2'))).toBe(false);
    expect(Object.isFrozen(owner)).toBe(true);
  });
});
