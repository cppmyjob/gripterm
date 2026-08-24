import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `tools/explain-store.mjs`, over a store folder and nothing else.
 *
 * **The question this answers, and why it needed a tool.** A person writes "my
 * terminals did not come back". The only thing they can send is their
 * `~/.gripterm` folder -- a command that reports has to be run IN the window
 * that went wrong, and they close it first. Every answer therefore has to be
 * recoverable from the folder, with no window and no questions.
 *
 * **It runs the PRODUCT'S OWN planner.** `planRestore` out of
 * `packages/core/dist`, the same function the extension calls, over the real
 * `FileTerminalRepository` and the real `FileOwnerPresence`. A second
 * implementation would answer a question about itself: the whole value here is
 * that the tool is wrong exactly where the product is wrong.
 *
 * The store below is BUILT here and is nobody's. Nothing in this suite reads,
 * writes or names `~/.gripterm`.
 */

const TOOL = join(__dirname, '..', 'tools', 'explain-store.mjs');

/** Long enough ago to be plainly not this run. */
const LONG_AGO = 1_786_500_000_000;

interface RecordSpec {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly ownerId: string;
  readonly workspaceFolder: string | null;
  readonly closedAt: number | null;
  readonly state: string;
  readonly pid: number | null;
}

function writeRecord(store: string, spec: RecordSpec): void {
  const directory = join(store, 'terminals', spec.terminalId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'observed.json'),
    JSON.stringify({
      state: spec.state,
      lastEventAt: LONG_AGO,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: spec.pid,
    }),
    'utf8'
  );
  writeFileSync(
    join(directory, 'record.json'),
    JSON.stringify({
      terminalId: spec.terminalId,
      sessionId: spec.sessionId,
      sessionIdHistory: [],
      owner: {
        kind: 'window',
        ownerId: spec.ownerId,
        editorKind: 'vscode',
        workspaceFolder: spec.workspaceFolder,
      },
      metadata: {
        displayName: spec.displayName,
        task: null,
        notes: [],
        tags: [],
        color: null,
      },
      launch: {
        cwd: tmpdir(),
        addDirs: [],
        permissionMode: null,
        agent: null,
        model: null,
        worktree: null,
        mcpConfigPaths: [],
        appendSystemPrompt: null,
        extraEnv: {},
      },
      createdAt: LONG_AGO,
      closedAt: spec.closedAt,
      revision: 3,
    }),
    'utf8'
  );
}

/** A window that is still running: a heartbeat of a second ago and a pid that answers. */
function writeLiveOwner(store: string, ownerId: string): void {
  const owners = join(store, 'owners');
  mkdirSync(owners, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(owners, `${ownerId}.json`),
    JSON.stringify({
      ownerId,
      kind: 'window',
      pid: process.pid,
      editorKind: 'vscode',
      editorVersion: '1.134.0',
      workspaceFolders: ['C:/projects/theirs'],
      startedAt: now - 60_000,
      heartbeatAt: now - 1000,
    }),
    'utf8'
  );
}

/**
 * The folder a person could have sent: five records, four of which did not come
 * back and each for a different reason, and one that would have.
 */
function buildStore(): string {
  const store = mkdtempSync(join(tmpdir(), 'gripterm-explain-'));
  mkdirSync(join(store, 'terminals'), { recursive: true });
  mkdirSync(join(store, 'owners'), { recursive: true });
  writeFileSync(join(store, 'version'), '1', 'utf8');

  writeLiveOwner(store, 'a-window-that-is-still-open');

  writeRecord(store, {
    terminalId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
    displayName: 'the one whose window is still open',
    ownerId: 'a-window-that-is-still-open',
    workspaceFolder: null,
    closedAt: null,
    state: 'ended',
    pid: null,
  });
  writeRecord(store, {
    terminalId: '22222222-2222-4222-8222-222222222222',
    sessionId: 'aaaaaaaa-2222-4222-8222-222222222222',
    displayName: 'the one the person threw away',
    ownerId: 'a-window-that-closed-long-ago',
    workspaceFolder: null,
    closedAt: LONG_AGO + 1000,
    state: 'ended',
    pid: null,
  });
  writeRecord(store, {
    terminalId: '33333333-3333-4333-8333-333333333333',
    sessionId: 'aaaaaaaa-3333-4333-8333-333333333333',
    displayName: 'the one belonging to another project',
    ownerId: 'a-window-that-closed-long-ago',
    workspaceFolder: 'C:/projects/somewhere-else',
    closedAt: null,
    state: 'ended',
    pid: null,
  });
  // Two records, one conversation: a copied store, and the hazard the whole
  // design exists against -- two `claude --resume` on one transcript.
  for (const half of ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']) {
    writeRecord(store, {
      terminalId: half,
      sessionId: 'aaaaaaaa-4444-4444-8444-444444444444',
      displayName: `a copy of one conversation (${half.slice(0, 8)})`,
      ownerId: 'a-window-that-closed-long-ago',
      workspaceFolder: null,
      closedAt: null,
      state: 'ended',
      pid: null,
    });
  }
  writeRecord(store, {
    terminalId: '66666666-6666-4666-8666-666666666666',
    sessionId: 'aaaaaaaa-6666-4666-8666-666666666666',
    displayName: 'the one that would have come back',
    ownerId: 'a-window-that-closed-long-ago',
    workspaceFolder: null,
    closedAt: null,
    state: 'ended',
    pid: null,
  });
  return store;
}

function explain(store: string, ...args: readonly string[]): string {
  return execFileSync(process.execPath, [TOOL, store, ...args], {
    encoding: 'utf8',
    cwd: join(__dirname, '..'),
  });
}

describe('explaining a store folder without a window', () => {
  let store = '';

  beforeAll(() => {
    store = buildStore();
  });

  afterAll(() => {
    const made = store;
    store = '';
    if (made !== '') {
      rmSync(made, { recursive: true, force: true });
    }
  });

  it('names, per record, why it did not come back', () => {
    const said = explain(store);

    expect(said).toContain('the one whose window is still open');
    expect(said).toContain('owner-live');
    expect(said).toContain('the window that opened it is still running');

    expect(said).toContain('the one the person threw away');
    expect(said).toContain('closed');
    expect(said).toContain('its terminal was closed on purpose');

    expect(said).toContain('a copy of one conversation');
    expect(said).toContain('duplicate-session');
    expect(said).toContain('another record names the same conversation');
  });

  it('says which record WOULD have come back, so the answer discriminates', () => {
    const said = explain(store);

    expect(said).toMatch(/the one that would have come back[\s\S]*?would come back/);
  });

  /*
   * The folder is a fact about the window that is ASKING, and nothing in a store
   * says which window that was. So the tool explains each record as its own
   * window would have seen it, and `--folder` asks the other question: what a
   * window with THESE folders open would have done.
   */
  it('answers the folder question when it is asked, instead of guessing', () => {
    const said = explain(store, '--folder', 'C:/projects/mine');

    expect(said).toContain('foreign-folder');
    expect(said).toContain('it belongs to a project this window does not have open');
  });

  /*
   * Two of the planner's inputs cannot be in a folder at all: what the CLI is
   * running, and which conversations have a transcript. A tool that quietly
   * assumed either would answer confidently about a question it never asked --
   * so it says what it assumed, in the same breath as the answer.
   */
  it('says out loud what it had to assume, because a folder cannot hold it', () => {
    const said = explain(store);

    expect(said).toContain('assumed');
    expect(said).toContain('--agents');
    expect(said).toContain('--transcripts');
  });

  it('refuses a folder that is not a store, rather than reporting nothing found', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gripterm-not-a-store-'));
    try {
      expect(() => explain(empty)).toThrow(/not a Gripterm store/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /*
   * The one promise that makes it safe to point at a copy of somebody's real
   * store: it reads. Checked by comparing the folder with itself afterwards
   * rather than by reading the source, because "it only reads" is exactly the
   * kind of claim that stops being true one careless line later.
   */
  it('writes nothing into the folder it is given', () => {
    const before = listing(store);
    explain(store);

    expect(listing(store)).toEqual(before);
  });
});

/** Every path under a folder with its size, which is what "nothing changed" means here. */
function listing(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(`${prefix}${entry.name}/`);
        walk(path, `${prefix}${entry.name}/`);
      } else {
        found.push(`${prefix}${entry.name} ${String(statSync(path).size)}`);
      }
    }
  };
  walk(root, '');
  return found;
}
