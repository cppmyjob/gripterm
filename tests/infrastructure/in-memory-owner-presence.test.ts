import {
  ConflictError,
  InMemoryOwnerPresence,
  OwnerId,
} from '../../packages/core/src/index';
import { makeOwnerIdentity } from '../helpers/domain-fixtures';

const US = makeOwnerIdentity();
const STRANGER = OwnerId.fromString('window-activation-9');

describe('before anyone has announced', () => {
  it('knows nobody and refuses the calls that presuppose an announcement', async () => {
    const presence = new InMemoryOwnerPresence();

    await expect(presence.survey()).resolves.toStrictEqual([]);
    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('unknown');
    await expect(presence.heartbeat()).rejects.toThrow(ConflictError);
    await expect(presence.retire()).rejects.toThrow(ConflictError);
  });
});

describe('after announcing', () => {
  it('reports itself live and surveys itself', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
    await expect(presence.survey()).resolves.toStrictEqual([
      { name: US.ownerId.value, fileName: US.ownerId.value, identity: US, heartbeatAt: null, liveness: 'live' },
    ]);
    await expect(presence.heartbeat()).resolves.toBeUndefined();
  });

  it('refuses to collect the only file it has, which is its own', async () => {
    // Same rule as the file presence, and for the same reason: a window
    // that takes away its own presence looks dead to everybody while it
    // runs, and its conversations become adoptable.
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.collect(US.ownerId.value)).rejects.toThrow(ConflictError);
    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
  });

  it('has nothing to collect for anybody else, and says so by doing nothing', async () => {
    // There are no other windows in a base no other process can reach, so
    // the honest answer is neither a throw nor a pretence of having swept.
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.collect(STRANGER.value)).resolves.toBeUndefined();
    await expect(presence.survey()).resolves.toHaveLength(1);
  });

  it('calls a window it has never heard of `unknown`, never `dead`', async () => {
    // The difference is not academic. `dead` authorises adopting that window's
    // terminals, which means a second `claude --resume` on a conversation that
    // already has one. An in-memory base cannot see other processes at all, so
    // silence about a stranger is ignorance, not evidence.
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.livenessOf(STRANGER)).resolves.toBe('unknown');
  });

  it('stays live however long it goes without a heartbeat', async () => {
    // Nothing to refresh: a heartbeat is a message to readers in other
    // processes, and the object answering is the very process being asked
    // about. The call exists for the lifecycle, not for the timestamp.
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
  });
});

describe('retiring', () => {
  it('turns the window dead and empties the survey', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);
    await presence.retire();

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('dead');
    await expect(presence.survey()).resolves.toStrictEqual([]);
  });

  it('refuses a heartbeat afterwards, as the file presence does', async () => {
    // The port's rule, kept identical in both implementations: a window that has
    // said it is leaving and goes on writing is exactly what liveness must be
    // able to trust. In the file presence a beat after retiring would recreate
    // the file; here there is nothing to recreate, and the call is still a
    // lifecycle mistake worth hearing about.
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);
    await presence.retire();

    await expect(presence.heartbeat()).rejects.toThrow(ConflictError);
  });

  it('is undone by announcing again', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);
    await presence.retire();
    await presence.announce(US);

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
    await expect(presence.survey()).resolves.toHaveLength(1);
  });
});
