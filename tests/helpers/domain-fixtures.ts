import {
  HumanMetadata,
  LaunchRecipe,
  Note,
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalEntry,
  TerminalId,
  type CreateTerminalEntryParams,
  type IdGenerator,
  type OwnerIdentity,
  type TerminalSpec,
} from '../../packages/core/src/index';

export const TERMINAL_UUID = '550e8400-e29b-41d4-a716-446655440000';
export const SESSION_UUID = 'ac2d74d7-1f3b-4c5e-9a80-0d1e2f3a4b5c';
export const NEXT_SESSION_UUID = '44a6e703-2b4c-4d6f-8a91-1e2f3a4b5c6d';

export const CREATED_AT = new Date('2026-08-10T09:00:00.000Z');
export const OBSERVED_AT = new Date('2026-08-10T09:30:00.000Z');

/** Hands out a known sequence, then refuses -- an exhausted stub is a broken test, not a random id. */
export function stubIdGenerator(...values: readonly string[]): IdGenerator {
  let index = 0;
  return {
    newUuid: (): string => {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error('the stub id generator ran out of values');
      }
      return value;
    },
  };
}

/**
 * Runs `action` and returns what it threw. Exists so that an assertion about
 * the thrown value can be written outside the `catch` -- an `expect` inside one
 * is silently skipped when nothing throws, which is exactly the case the
 * assertion was meant to catch.
 */
export function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('the action was expected to throw, and did not');
}

export function makeOwnerRef(ownerId = 'window-activation-1'): OwnerRef {
  return OwnerRef.create({
    kind: 'window',
    ownerId: OwnerId.fromString(ownerId),
    editorKind: 'vscode',
    workspaceFolder: 'D:/Projects/foo',
  });
}

export function makeMetadata(): HumanMetadata {
  return HumanMetadata.create({
    displayName: 'auth-refactor',
    task: 'Move token validation into its own service',
    notes: [Note.create(CREATED_AT, 'Read ADR-014 first')],
    tags: ['backend'],
    color: 'terminal.ansiCyan',
  });
}

export function makeRecipe(): LaunchRecipe {
  return LaunchRecipe.create({
    cwd: 'D:/Projects/foo',
    addDirs: [],
    permissionMode: null,
    agent: null,
    model: null,
    worktree: null,
    mcpConfigPaths: [],
    appendSystemPrompt: null,
    extraEnv: {},
  });
}

export function makeObserved(): ObservedState {
  return ObservedState.create({
    state: 'idle',
    lastEventAt: OBSERVED_AT,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

export function makeOwnerIdentity(ownerId = 'window-activation-1'): OwnerIdentity {
  return {
    ownerId: OwnerId.fromString(ownerId),
    kind: 'window',
    pid: 4242,
    editorKind: 'vscode',
    editorVersion: '1.132.0',
    workspaceFolders: ['D:/Projects/foo'],
  };
}

export function makeTerminalSpec(): TerminalSpec {
  return {
    terminalId: TerminalId.fromString(TERMINAL_UUID),
    name: 'auth-refactor',
    cwd: 'D:/Projects/foo',
    env: { GRIPTERM_TOKEN: 'secret' },
    shellPath: 'C:/Users/x/.local/bin/claude.exe',
    shellArgs: ['--session-id', TERMINAL_UUID],
  };
}

export function makeEntry(overrides: Partial<CreateTerminalEntryParams> = {}): TerminalEntry {
  return TerminalEntry.create({
    terminalId: TerminalId.fromString(TERMINAL_UUID),
    sessionId: SessionId.fromString(SESSION_UUID),
    owner: makeOwnerRef(),
    metadata: makeMetadata(),
    launch: makeRecipe(),
    observed: makeObserved(),
    createdAt: CREATED_AT,
    ...overrides,
  });
}
