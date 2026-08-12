import {
  HEARTBEAT_INTERVAL_MS,
  InMemoryOwnerPresence,
  OwnerHeartbeat,
  OwnerId,
} from '../../packages/core/src/index';
import type { OwnerIdentity, OwnerPresence } from '../../packages/core/src/index';
import { FakeScheduler, RecordingLogger } from '../helpers/port-fakes';

/**
 * The loop the whole of §4.8's liveness rests on. A window whose heartbeat
 * stops looks `unknown` after a minute and adoptable after that, so each test
 * below is about which way a failure errs.
 */

const IDENTITY: OwnerIdentity = {
  ownerId: OwnerId.fromString('window-activation-1'),
  kind: 'window',
  pid: 4242,
  editorKind: 'vscode',
  editorVersion: '1.132.0',
  workspaceFolders: ['D:/Projects/foo'],
};

interface Stand {
  readonly presence: InMemoryOwnerPresence;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly heartbeat: OwnerHeartbeat;
}

function stand(presence: OwnerPresence = new InMemoryOwnerPresence()): Stand {
  const scheduler = new FakeScheduler();
  const logger = new RecordingLogger();
  return {
    presence: presence as InMemoryOwnerPresence,
    scheduler,
    logger,
    heartbeat: new OwnerHeartbeat({ presence, scheduler, logger }),
  };
}

describe('a window saying it is here', () => {
  it('announces itself and then beats on the interval the contract names', async () => {
    const { scheduler, presence, heartbeat } = stand();

    await heartbeat.start(IDENTITY);

    expect(await presence.livenessOf(IDENTITY.ownerId)).toBe('live');
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.ms).toBe(HEARTBEAT_INTERVAL_MS);
  });

  it('keeps beating, one wait at a time', async () => {
    const { scheduler, heartbeat } = stand();
    await heartbeat.start(IDENTITY);

    scheduler.elapse();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.armed).toHaveLength(2);
  });

  /*
   * A transient write failure -- a scanner holding the file, a full disk for a
   * moment -- must not end presence for the rest of the session: the
   * consequence of stopping is another window adopting terminals out from under
   * this one.
   */
  it('goes on beating after a beat that failed, and says so', async () => {
    const presence = new InMemoryOwnerPresence();
    const { scheduler, logger, heartbeat } = stand(presence);
    await heartbeat.start(IDENTITY);
    presence.heartbeat = async (): Promise<void> => {
      throw new Error('EPERM: something has the file open');
    };

    scheduler.elapse();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warnings[0]?.message).toContain('could not write its heartbeat');
    expect(scheduler.live).toHaveLength(1);
  });

  /*
   * The order the port demands: a beat landing after the goodbye would recreate
   * the file this window has just deleted, leaving a presence file with no
   * window behind it and no timer to keep it honest.
   */
  it('stops the timer before it retires, so nothing beats afterwards', async () => {
    const { scheduler, presence, heartbeat } = stand();
    await heartbeat.start(IDENTITY);

    await heartbeat.stop();

    expect(scheduler.live).toEqual([]);
    expect(await presence.livenessOf(IDENTITY.ownerId)).toBe('dead');
  });

  it('is safe to stop without ever having started, and to stop twice', async () => {
    // `deactivate` runs on paths this class cannot see: an activation that
    // failed halfway, a reload during startup.
    const { presence, heartbeat } = stand();

    await expect(heartbeat.stop()).resolves.toBeUndefined();
    await heartbeat.start(IDENTITY);
    await heartbeat.stop();
    await expect(heartbeat.stop()).resolves.toBeUndefined();
    expect(await presence.livenessOf(IDENTITY.ownerId)).toBe('dead');
  });

  /*
   * A file left behind is not a disaster -- its heartbeat stops with the window,
   * so it goes stale in a minute -- but the window it names looks `unknown` for
   * that minute rather than plainly gone, and that is worth a line.
   */
  it('survives a failed goodbye and reports it', async () => {
    const presence = new InMemoryOwnerPresence();
    const { logger, heartbeat } = stand(presence);
    await heartbeat.start(IDENTITY);
    presence.retire = async (): Promise<void> => {
      throw new Error('the store is gone');
    };

    await expect(heartbeat.stop()).resolves.toBeUndefined();

    expect(logger.warnings[0]?.message).toContain('could not remove its presence file');
  });

  /*
   * The composition root has to know: a window that could not write its
   * presence file is a window whose terminals other windows may adopt, and that
   * is a decision, not a log line.
   */
  it('lets a failed announcement through to the caller, and arms nothing', async () => {
    const presence = new InMemoryOwnerPresence();
    presence.announce = async (): Promise<void> => {
      throw new Error('the owners directory is not writable');
    };
    const { scheduler, heartbeat } = stand(presence);

    await expect(heartbeat.start(IDENTITY)).rejects.toThrow('not writable');

    expect(scheduler.armed).toEqual([]);
  });

  it('cancels the wait when the window is disposed without a goodbye', async () => {
    // `context.subscriptions` cannot await, so this half only stops the timer.
    // The retirement is `deactivate`'s, which can.
    const { scheduler, heartbeat } = stand();
    await heartbeat.start(IDENTITY);

    heartbeat.dispose();

    expect(scheduler.live).toEqual([]);
  });
});
