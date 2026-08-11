import {
  ClaudeCodeCommandFactory,
  type SessionSettingsStore,
} from '../../../packages/core/src/domain/agents/claude-code/command-factory';
import {
  ListeningAddress,
  StorageError,
  TOKEN_ENV_VAR,
  TerminalId,
  hookEventUrl,
  type AgentCommand,
  type SessionSettingsDocument,
  type TerminalEntry,
} from '../../../packages/core/src/index';
import { TERMINAL_UUID, SESSION_UUID, makeEntry } from '../../helpers/domain-fixtures';

const ADDRESS = ListeningAddress.loopback(51_337);
const CLAUDE = 'C:/Users/x/.local/bin/claude.exe';
const TOKEN = 'e6b1f0d2c3a4';
const FORWARDER = {
  interpreterPath: 'C:/Program Files/nodejs/node.exe',
  scriptPath: 'C:/ext/assets/gripterm-forwarder.js',
};

/** Records what it was asked to write, and hands back a path as the real one does. */
class RecordingStore implements SessionSettingsStore {
  public readonly written: { terminalId: string, document: SessionSettingsDocument }[] = [];

  public async write(terminalId: TerminalId, document: SessionSettingsDocument): Promise<string> {
    this.written.push({ terminalId: terminalId.value, document });
    return `C:/Users/x/.gripterm/terminals/${terminalId.value}/settings.json`;
  }
}

class RefusingStore implements SessionSettingsStore {
  public async write(): Promise<string> {
    throw new StorageError('the disk said no');
  }
}

function factory(store: SessionSettingsStore = new RecordingStore()): ClaudeCodeCommandFactory {
  return new ClaudeCodeCommandFactory({
    executablePath: CLAUDE,
    address: ADDRESS,
    token: TOKEN,
    sessionStart: FORWARDER,
    settings: store,
  });
}

async function commandFor(
  store: SessionSettingsStore = new RecordingStore(),
  entry: TerminalEntry = makeEntry()
): Promise<AgentCommand> {
  return await factory(store).commandFor(entry, 'launch');
}

describe('assembling the command that starts Claude Code', () => {
  it('writes this terminal its settings file and passes that very path', async () => {
    // The two halves cannot be checked apart. A file written somewhere else, or
    // a path passed that nothing wrote, both give a terminal that runs
    // perfectly and reports nothing -- and neither shows up as an error.
    const store = new RecordingStore();

    const command = await commandFor(store);

    expect(store.written).toHaveLength(1);
    expect(store.written[0]?.terminalId).toBe(TERMINAL_UUID);
    // And the forwarder reached the file: without it `SessionStart` is the one
    // event that never arrives, and nothing else would say so.
    expect(store.written[0]?.document.hooks.SessionStart[0]?.hooks[0]).toMatchObject({
      type: 'command',
      command: FORWARDER.interpreterPath,
    });
    const written = store.written[0];
    expect(command.args).toContain(
      `C:/Users/x/.gripterm/terminals/${written?.terminalId ?? ''}/settings.json`
    );
  });

  it('finishes writing before it hands back a command', async () => {
    // `--settings` names a file the CLI reads in its first milliseconds, and the
    // caller starts the process the moment this promise resolves. This is why
    // the port is asynchronous at all (§4.5).
    let finished = false;
    const store: SessionSettingsStore = {
      write: async (terminalId) => {
        await Promise.resolve();
        finished = true;
        return `/tmp/${terminalId.value}.json`;
      },
    };

    await commandFor(store);

    expect(finished).toBe(true);
  });

  it('addresses the hooks in that file at this terminal', async () => {
    const store = new RecordingStore();

    await commandFor(store);

    const url = hookEventUrl(ADDRESS, TerminalId.fromString(TERMINAL_UUID));
    const hook = store.written[0]?.document.hooks.Stop[0]?.hooks[0];
    expect(hook).toMatchObject({ type: 'http', url });
  });

  it('carries the token to the process, since the hooks send it back', async () => {
    const command = await commandFor();

    expect(command.env[TOKEN_ENV_VAR]).toBe(TOKEN);
  });

  it('starts the named conversation on a launch', async () => {
    const command = await commandFor();

    expect(command.args).toContain('--session-id');
    expect(command.args).toContain(SESSION_UUID);
    expect(command.args).not.toContain('--resume');
  });

  it('resumes it on a resume', async () => {
    const command = await factory().commandFor(makeEntry(), 'resume');

    expect(command.args).toContain('--resume');
    expect(command.args).not.toContain('--session-id');
  });

  it('runs the executable it was given rather than a name from somebody PATH', async () => {
    const command = await commandFor();

    expect(command.executable).toBe(CLAUDE);
  });

  it('writes the file again for every start', async () => {
    // The port inside it belongs to THIS activation, and a restore is a start
    // too (§4.4). A cached file would hand the next window a dead port -- which
    // is silent, because a failed hook is non-blocking.
    const store = new RecordingStore();
    const one = factory(store);

    await one.commandFor(makeEntry(), 'launch');
    await one.commandFor(makeEntry(), 'resume');

    expect(store.written).toHaveLength(2);
  });

  it('fails loudly when the file cannot be written, rather than launching blind', async () => {
    await expect(commandFor(new RefusingStore())).rejects.toThrow(StorageError);
  });

  it('leaves SessionStart unregistered when there is no forwarder to run', async () => {
    const store = new RecordingStore();
    const blind = new ClaudeCodeCommandFactory({
      executablePath: CLAUDE,
      address: ADDRESS,
      token: TOKEN,
      sessionStart: null,
      settings: store,
    });

    await blind.commandFor(makeEntry(), 'launch');

    expect(store.written[0]?.document.hooks.SessionStart).toEqual([]);
  });
});
