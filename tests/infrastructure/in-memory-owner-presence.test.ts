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

    await expect(presence.listOwners()).resolves.toStrictEqual([]);
    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('unknown');
    await expect(presence.heartbeat()).rejects.toThrow(ConflictError);
    await expect(presence.retire()).rejects.toThrow(ConflictError);
  });
});

describe('after announcing', () => {
  it('reports itself live and lists itself', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
    await expect(presence.listOwners()).resolves.toStrictEqual([US]);
    await expect(presence.heartbeat()).resolves.toBeUndefined();
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
  it('turns the window dead and empties the list', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);
    await presence.retire();

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('dead');
    await expect(presence.listOwners()).resolves.toStrictEqual([]);
  });

  it('is undone by announcing again', async () => {
    const presence = new InMemoryOwnerPresence();
    await presence.announce(US);
    await presence.retire();
    await presence.announce(US);

    await expect(presence.livenessOf(US.ownerId)).resolves.toBe('live');
    await expect(presence.listOwners()).resolves.toStrictEqual([US]);
  });
});
