import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DEBOUNCE_MS,
  RepositoryWatcher,
  StorageLayout,
  SystemScheduler,
  describeDetails,
  watchedName,
} from '../../packages/core/src/index';
import type { DirectoryEvents, DirectoryHandle, DirectoryWatch } from '../../packages/core/src/index';
import { FakeScheduler, RecordingLogger } from '../helpers/port-fakes';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * The watcher is where three measured properties of `fs.watch` on Windows meet a
 * design, so the tests are mostly about what is done with a platform event
 * rather than about the platform. The platform's own half -- that a recursive
 * watcher really does report a file two levels down -- is measured at the bottom
 * of this file, in a real directory, because a rule proven only against a fake
 * is a rule about the fake.
 */

const BASE = 'C:\\base';
const DAY_FILE = `${TERMINAL_UUID}\\events\\2026-08-12.ndjson`;
const RECORD_FILE = `${TERMINAL_UUID}\\record.json`;

/** A watch that hands the test the platform's end of every root it attached to. */
class FakeWatch {
  public readonly attached = new Map<string, DirectoryEvents>();
  /**
   * Every attach, in order, INCLUDING a repeat of one already attached.
   *
   * Separate from `attached` because that one is keyed by path and a second
   * attach to the same root merely overwrites it -- which is exactly how a
   * watcher that doubled its handles on the second `start()` passed this file
   * until a mutation said otherwise.
   */
  public readonly attachments: string[] = [];
  public readonly closed: string[] = [];
  /** Roots this fake refuses to attach to, as the platform refuses a missing one. */
  public readonly refuse = new Set<string>();
  /** Roots whose failure arrives synchronously, before `watch` has returned. */
  public readonly failWhileAttaching = new Set<string>();

  public readonly attach: DirectoryWatch = (path, events): DirectoryHandle => {
    if (this.refuse.has(path)) {
      throw Object.assign(new Error(`ENOENT: no such directory, watch '${path}'`), {
        code: 'ENOENT',
      });
    }
    this.attached.set(path, events);
    this.attachments.push(path);
    if (this.failWhileAttaching.has(path)) {
      events.onError(new Error('the platform gave up immediately'));
    }
    return {
      close: (): void => {
        this.closed.push(path);
      },
    };
  };

  /** Delivers one platform event on a root. */
  public change(path: string, filename: string | null): void {
    this.eventsFor(path).onChange(filename);
  }

  public fail(path: string, cause: unknown): void {
    this.eventsFor(path).onError(cause);
  }

  public eventsFor(path: string): DirectoryEvents {
    const events = this.attached.get(path);
    if (events === undefined) {
      throw new Error(`nothing was watching ${path}`);
    }
    return events;
  }
}

interface Stand {
  readonly layout: StorageLayout;
  readonly platform: FakeWatch;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly watcher: RepositoryWatcher;
  readonly reads: () => number;
}

function stand(options: { debounceMs?: number } = {}): Stand {
  const layout = new StorageLayout(BASE);
  const platform = new FakeWatch();
  const scheduler = new FakeScheduler();
  const logger = new RecordingLogger();
  const watcher = new RepositoryWatcher({
    layout,
    scheduler,
    logger,
    watch: platform.attach,
    ...options,
  });
  let reads = 0;
  watcher.watch(() => {
    reads += 1;
  });
  return { layout, platform, scheduler, logger, watcher, reads: () => reads };
}

describe('what the repository watcher attaches to', () => {
  it('watches both roots, because a window dying is a change too', () => {
    const rig = stand();

    rig.watcher.start();

    expect([...rig.platform.attached.keys()]).toEqual([
      rig.layout.terminalsDir,
      rig.layout.ownersDir,
    ]);
  });

  /*
   * A doubled handle is not merely wasteful: on this platform every watcher
   * holds the directory open, and the second one would still be holding it after
   * the first was closed -- which is the state §4.8 forbids before a directory is
   * deleted or moved.
   */
  it('ignores a second start rather than doubling the handles', () => {
    const rig = stand();

    rig.watcher.start();
    rig.watcher.start();

    expect(rig.platform.attachments).toEqual([rig.layout.terminalsDir, rig.layout.ownersDir]);
  });

  it('does not start again once disposed', () => {
    const rig = stand();

    rig.watcher.dispose();
    rig.watcher.start();

    expect(rig.platform.attached.size).toBe(0);
  });

  /*
   * Measured on this machine: `fs.watch` on a directory that is not there throws
   * ENOENT synchronously. One unwatchable root must not cost the other one --
   * `owners/` still answers the question "did that window die".
   */
  it('reports a root it cannot watch and keeps the other', () => {
    const rig = stand();
    rig.platform.refuse.add(rig.layout.terminalsDir);

    rig.watcher.start();

    expect(rig.logger.errors[0]?.message).toContain('could not be watched');
    expect(rig.logger.errors[0]?.details).toMatchObject({ path: rig.layout.terminalsDir });
    expect([...rig.platform.attached.keys()]).toEqual([rig.layout.ownersDir]);
  });

  it('survives a platform that fails before it has even handed back a handle', () => {
    const rig = stand();
    rig.platform.failWhileAttaching.add(rig.layout.terminalsDir);

    expect(() => {
      rig.watcher.start();
    }).not.toThrow();
    expect(rig.platform.attached.size).toBe(2);
  });
});

describe('which platform events are worth a re-read', () => {
  it('asks for one when a record changes', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);

    expect(rig.reads()).toBe(0);
    rig.scheduler.elapse();
    expect(rig.reads()).toBe(1);
  });

  it('asks for one when an owner file changes, so a dead window is seen at once', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.change(rig.layout.ownersDir, 'e5f6a7b8.json');
    rig.scheduler.elapse();

    expect(rig.reads()).toBe(1);
  });

  it('says nothing about the journal, which no window reads', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, DAY_FILE);
    rig.platform.change(rig.layout.terminalsDir, `${TERMINAL_UUID}\\events`);
    rig.platform.change(rig.layout.terminalsDir, `${TERMINAL_UUID}/events/2026-08-13.ndjson`);

    expect(rig.scheduler.armed).toEqual([]);
    expect(rig.reads()).toBe(0);
  });

  /*
   * The rule this milestone exists to get right. libuv's 4096-byte buffer
   * collapses a lost batch into one nameless event -- at about twenty files of
   * our path shape -- so a nameless event is not "an event we could not
   * classify, skip it" but "you have missed something and cannot know what".
   * An implementation that filtered by name and dropped this would lose changes
   * in proportion to how many terminals are open.
   */
  it('re-reads everything when the platform lost the names', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, null);
    rig.scheduler.elapse();

    expect(rig.reads()).toBe(1);
  });

  it('treats a name it cannot read as a lost batch, not as a name', () => {
    expect(watchedName('a\\b.json')).toBe('a\\b.json');
    expect(watchedName(null)).toBeNull();
    expect(watchedName(Buffer.from('a\\b.json'))).toBeNull();
  });
});

describe('how a burst becomes one re-read', () => {
  it('collapses a storm into a single wait, and does not push the deadline back', () => {
    const rig = stand();
    rig.watcher.start();

    for (let index = 0; index < 200; index += 1) {
      rig.platform.change(rig.layout.terminalsDir, `${TERMINAL_UUID}\\record.json`);
    }

    // One armed timer for two hundred events -- and, more importantly, one that
    // was armed by the FIRST of them. A debounce that restarted on each event
    // would never fire under the storm measured in §4.8 (122 021 events in
    // 1.5 s), which is precisely when the list must not go quiet.
    expect(rig.scheduler.armed).toHaveLength(1);
    rig.scheduler.elapse();
    expect(rig.reads()).toBe(1);
  });

  it('waits again for what happened after the last re-read', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);
    rig.scheduler.elapse();
    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);
    rig.scheduler.elapse();

    expect(rig.reads()).toBe(2);
  });

  it('waits as long as it was told to, and by default as long as the constant says', () => {
    const quick = stand({ debounceMs: 25 });
    quick.watcher.start();
    quick.platform.change(quick.layout.terminalsDir, RECORD_FILE);

    const usual = stand();
    usual.watcher.start();
    usual.platform.change(usual.layout.terminalsDir, RECORD_FILE);

    expect(quick.scheduler.armed[0]?.ms).toBe(25);
    expect(usual.scheduler.armed[0]?.ms).toBe(DEFAULT_DEBOUNCE_MS);
  });
});

describe('the listeners', () => {
  it('all hear one signal, and an unsubscribed one hears nothing', () => {
    const rig = stand();
    let second = 0;
    const subscription = rig.watcher.watch(() => {
      second += 1;
    });
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);
    rig.scheduler.elapse();
    subscription.dispose();
    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);
    rig.scheduler.elapse();

    expect(second).toBe(1);
    expect(rig.reads()).toBe(2);
  });

  /*
   * The notification runs from a timer, so a throw that escaped would land
   * nowhere a caller could catch it -- and would take the remaining listeners
   * with it.
   */
  it('are not stopped by one of them failing', () => {
    const rig = stand();
    rig.watcher.watch(() => {
      throw new Error('the tree gave up');
    });
    let after = 0;
    rig.watcher.watch(() => {
      after += 1;
    });
    rig.watcher.start();

    rig.platform.change(rig.layout.terminalsDir, null);
    rig.scheduler.elapse();

    expect(after).toBe(1);
    expect(rig.logger.errors[0]?.message).toContain('a listener failed');
  });
});

describe('going blind', () => {
  /*
   * Not retried, and said out loud: there is no measurement behind any
   * particular retry interval, and a silent reattachment that also failed would
   * look exactly like working observation.
   */
  it('says so with the path, and asks for one last re-read', () => {
    const rig = stand();
    rig.watcher.start();

    rig.platform.fail(rig.layout.ownersDir, new Error('ENOSPC: no watches left'));
    rig.scheduler.elapse();

    expect(rig.logger.errors[0]?.message).toContain('stopped reporting changes');
    expect(rig.logger.errors[0]?.details).toMatchObject({ path: rig.layout.ownersDir });
    expect(rig.reads()).toBe(1);
  });
});

describe('disposal', () => {
  it('closes both roots and cancels the wait in flight', () => {
    const rig = stand();
    rig.watcher.start();
    rig.platform.change(rig.layout.terminalsDir, RECORD_FILE);

    rig.watcher.dispose();

    expect(rig.platform.closed).toEqual([rig.layout.terminalsDir, rig.layout.ownersDir]);
    expect(rig.scheduler.live).toEqual([]);
    expect(rig.reads()).toBe(0);
  });

  it('closes cleanly with nothing waiting', () => {
    const rig = stand();
    rig.watcher.start();

    rig.watcher.dispose();

    expect(rig.scheduler.armed).toEqual([]);
  });

  /*
   * A watcher is closed BEFORE the directory under it is deleted or moved
   * (§4.8), and the platform keeps delivering for a moment afterwards. Nothing
   * that arrives then may reach a listener that has already been let go.
   */
  it('leaves a late platform event with nobody to tell', () => {
    const rig = stand();
    rig.watcher.start();
    const events = rig.platform.eventsFor(rig.layout.terminalsDir);

    rig.watcher.dispose();
    events.onChange(null);

    expect(rig.scheduler.armed).toEqual([]);
    expect(rig.reads()).toBe(0);
  });
});

/**
 * The other half of the claim: that the platform, on this machine, really does
 * report a file two levels below a recursive root -- and that the default
 * implementation wires it to the debounce. Real directory, real `fs.watch`, real
 * timer.
 */
describe('the platform itself', () => {
  const WAIT_MS = 5000;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gripterm-watcher-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports a record written two levels down, and the watcher passes it on', async () => {
    const layout = new StorageLayout(root);
    const logger = new RecordingLogger();
    const watcher = new RepositoryWatcher({
      layout,
      scheduler: new SystemScheduler(),
      logger,
      debounceMs: 20,
    });
    const seen = new Promise<void>((resolve) => {
      watcher.watch(resolve);
    });

    try {
      // The roots have to exist before anything can watch them, which is what
      // the migrator does at activation.
      await mkdir(join(layout.terminalsDir, TERMINAL_UUID), { recursive: true });
      await mkdir(layout.ownersDir, { recursive: true });
      watcher.start();

      await writeFile(join(layout.terminalsDir, TERMINAL_UUID, 'record.json'), '{}', 'utf8');

      await Promise.race([
        seen,
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`no change reported in ${WAIT_MS} ms`));
          }, WAIT_MS).unref();
        }),
      ]);
    } finally {
      watcher.dispose();
    }

    expect(logger.errors).toEqual([]);
  }, 20_000);

  it('reports a root that is not there instead of throwing out of start()', () => {
    const logger = new RecordingLogger();
    const watcher = new RepositoryWatcher({
      layout: new StorageLayout(join(root, 'never-created')),
      scheduler: new FakeScheduler(),
      logger,
    });

    expect(() => {
      watcher.start();
    }).not.toThrow();
    watcher.dispose();

    expect(logger.errors).toHaveLength(2);
    // The failure itself and not a rendering of it (Ш3): `code` is what a branch
    // reacts to, and the string this used to carry threw it away along with the
    // stack -- so a log line could not be compared with the decision the code
    // took. The promise here is the one it always was: the reason a root could
    // not be watched reaches the log.
    const rendered = describeDetails(logger.errors[0]?.details);
    expect(rendered).toContain('"code":"ENOENT"');
    expect(rendered).toContain('"stack":');
  });
});
