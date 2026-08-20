import {
  LAUNCH_MODES,
  TERMINAL_ENGINES,
  TerminalId,
  chooseEngine,
  isTerminalEngine,
  remindOnFirstTerminal,
} from '../../packages/core/src/index';
import type {
  Disposable,
  LaunchMode,
  TerminalEngine,
  TerminalGateway,
  TerminalHandle,
  TerminalSpec,
} from '../../packages/core/src/index';

/**
 * Which engine actually runs, out of the one that was asked for.
 *
 * There is exactly one pair that cannot be honoured, and it is a fact about what
 * the two settings mean rather than a limitation of any adapter.
 * `gripterm.launch.mode: shell` starts the person's own shell and TYPES the
 * launch line into it, and the line must not overtake whatever the environment
 * does to a fresh shell (measured 2026-08-14, M2.25: another extension types
 * into a terminal 20-60 ms after it is made, and our line sent on creation lands
 * first). Knowing when a shell has gone quiet is the editor's shell integration.
 * A pty of ours has none, so `own` + `shell` would type the launch line into
 * whatever the shell was doing -- or into nothing.
 *
 * It refuses ALOUD and falls back, which is O5: the `editor` engine stays whole
 * and stays the way back. A refusal that only reached the log would leave a
 * person with a setting that reads `own` and a terminal that is not.
 *
 * The table below is total over both settings -- two engines by two modes -- so
 * a third mode or a third engine fails the compile of this suite rather than
 * silently taking the branch nobody chose.
 */

const CASES: readonly {
  readonly setting: TerminalEngine;
  readonly mode: LaunchMode;
  readonly engine: TerminalEngine;
  readonly refused: boolean;
}[] = [
  { setting: 'editor', mode: 'process', engine: 'editor', refused: false },
  { setting: 'editor', mode: 'shell', engine: 'editor', refused: false },
  { setting: 'own', mode: 'process', engine: 'own', refused: false },
  { setting: 'own', mode: 'shell', engine: 'editor', refused: true },
];

describe('chooseEngine answers for every pair of settings', () => {
  it.each(CASES)(
    'engine $setting with mode $mode runs $engine',
    ({ setting, mode, engine, refused }) => {
      const choice = chooseEngine(setting, mode);

      expect(choice.engine).toBe(engine);
      expect(choice.refusal === null).toBe(!refused);
    }
  );

  it('covers every engine and every mode', () => {
    // The guard on the table above: a fifth pair arriving with no row would
    // otherwise be a case this suite says nothing about.
    for (const setting of TERMINAL_ENGINES) {
      for (const mode of LAUNCH_MODES) {
        expect(CASES.some((row) => row.setting === setting && row.mode === mode)).toBe(true);
      }
    }
    expect(CASES).toHaveLength(TERMINAL_ENGINES.length * LAUNCH_MODES.length);
  });
});

describe('the one refusal says what it refused and what it did instead', () => {
  it('names both settings, so the sentence tells a person what to change', () => {
    // Asserted as content and not as a golden string: this sentence reaches a
    // person through a notification, and a message naming neither setting would
    // leave them looking for a switch they cannot find.
    const { refusal } = chooseEngine('own', 'shell');

    expect(refusal).toContain('gripterm.terminal.engine');
    expect(refusal).toContain('gripterm.launch.mode');
  });

  it('says which engine is running now', () => {
    expect(chooseEngine('own', 'shell').refusal).toContain('editor');
  });
});

describe('the engine names survive the settings file', () => {
  it('is exactly two, and the way back is one of them', () => {
    expect(TERMINAL_ENGINES).toStrictEqual(['editor', 'own']);
  });

  it.each([...TERMINAL_ENGINES])('reads %s back', (engine) => {
    expect(isTerminalEngine(engine)).toBe(true);
  });

  it.each(['own-pty', 'Own', '', 'editor '])('refuses %p', (value) => {
    expect(isTerminalEngine(value)).toBe(false);
  });
});

/**
 * The other half of O5, opened by a measurement of the EDITOR rather than of us.
 *
 * M3.14 in Cursor (2026-08-20): the fallback happened exactly as promised -- the
 * terminal came up in the editor's own panel -- and the person never heard it.
 * The cause is in the workbench bundle and not in a guess:
 *
 *   PURGE_TIMEOUT={[Info]:15e3,[Warning]:18e3,[Error]:2e4,[Success]:15e3}
 *   get sticky(){if(this._sticky)return!0;const e=this.hasActions;
 *     return!!(e&&this._severity===Error||!e&&this._expanded||this._progress&&...)}
 *
 * A warning toast is taken away after eighteen seconds, and only an ERROR with
 * buttons is sticky -- so a button would not have saved it either. Ours is said
 * inside `activate`, which is where a person is answering the trust question
 * about the folder, and eighteen seconds later it is in the bell, unread.
 *
 * Hence the second sentence, at the one moment the person is certainly looking
 * at this window: a terminal they asked for has just appeared, and it is not the
 * kind the setting promised.
 *
 * THE PRICE, named where the rule is: if the first terminal of the window is one
 * a RESTORE made during startup, the reminder is spent there and lands in the
 * same crowded second as the first. The bell still holds both. REMOVED WHEN a
 * gateway can be told who asked for a terminal -- `TerminalSpec` carries no
 * intent today, and inventing one for a notification would be the tail wagging.
 */

class GatewayThatCounts implements TerminalGateway, Disposable {
  public creates = 0;
  public disposed = false;
  public readonly engine = 'editor' as const;
  private readonly _made: TerminalHandle[] = [];

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.creates += 1;
    const handle = { terminalId: spec.terminalId } as unknown as TerminalHandle;
    this._made.push(handle);
    return await Promise.resolve(handle);
  }

  public listKnown(): readonly TerminalHandle[] {
    return this._made;
  }

  public handleFor(terminalId: TerminalId): TerminalHandle | undefined {
    return this._made.find((one) => one.terminalId.value === terminalId.value);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

const SOME_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_ID = '4f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function specFor(raw: string): TerminalSpec {
  return { terminalId: TerminalId.fromString(raw) } as unknown as TerminalSpec;
}

describe('a fallback says itself again where the person is looking', () => {
  it('says nothing until a terminal is actually made', () => {
    const said: string[] = [];
    remindOnFirstTerminal(new GatewayThatCounts(), (message) => said.push(message), 'the sentence');

    // Building a gateway is not an event in anybody's day. A window that falls
    // back and is then left alone has already said its piece in `activate`.
    expect(said).toStrictEqual([]);
  });

  it('says it when the first terminal appears, and once', async () => {
    const said: string[] = [];
    const gateway = remindOnFirstTerminal(
      new GatewayThatCounts(),
      (message) => said.push(message),
      'the sentence'
    );

    await gateway.create(specFor(SOME_ID));
    await gateway.create(specFor(OTHER_ID));

    // Twice would be nagging, and a person who has seen it once and opened a
    // second terminal anyway has decided.
    expect(said).toStrictEqual(['the sentence']);
  });

  it('hands the rest of the port through untouched', async () => {
    const inner = new GatewayThatCounts();
    const gateway = remindOnFirstTerminal(inner, () => undefined, 'the sentence');
    const id = TerminalId.fromString(SOME_ID);

    const handle = await gateway.create(specFor(SOME_ID));
    gateway.dispose();

    // The engine especially: the record is stamped from `gateway.engine`, so a
    // wrapper that answered for itself would be a record that lies about which
    // engine made the terminal -- and reconciliation ends the processes of `own`
    // and only those.
    expect(gateway.engine).toBe('editor');
    expect(gateway.handleFor(id)).toBe(handle);
    expect(gateway.listKnown()).toStrictEqual([handle]);
    expect(inner.creates).toBe(1);
    expect(inner.disposed).toBe(true);
  });
});
