import {
  ConflictError,
  InMemoryTerminalRepository,
  NotFoundError,
  OwnerId,
  SessionId,
  TerminalId,
  ValidationError,
} from '../../packages/core/src/index.js';
import {
  NEXT_SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeOwnerRef,
} from '../helpers/domain-fixtures.js';

const OURS = makeOwnerRef();
const THEIRS = makeOwnerRef('window-activation-2');
const ABSENT_ID = TerminalId.fromString('11111111-2222-4333-8444-555555555555');

function repository(): InMemoryTerminalRepository {
  return new InMemoryTerminalRepository(OURS);
}

describe('reading and writing', () => {
  it('starts empty and returns what was written', async () => {
    const repo = repository();
    const entry = makeEntry();

    await expect(repo.readAll()).resolves.toStrictEqual([]);
    await repo.write(entry);

    await expect(repo.readAll()).resolves.toStrictEqual([entry]);
    await expect(repo.readOwn(OURS.ownerId)).resolves.toStrictEqual([entry]);
    await expect(repo.readOwn(THEIRS.ownerId)).resolves.toStrictEqual([]);
  });

  it('replaces an entry with the same terminal id rather than accumulating it', async () => {
    const repo = repository();
    const first = makeEntry();
    const second = first.withSessionId(SessionId.fromString(NEXT_SESSION_UUID));

    await repo.write(first);
    await repo.write(second);

    await expect(repo.readAll()).resolves.toHaveLength(1);
  });

  it('refuses an entry owned by another window', async () => {
    // The single-writer rule, enforced rather than agreed. Writing someone
    // else's record is legitimate only after adopting it, and adoption makes
    // the record ours -- so "foreign" and "writable" never overlap.
    const repo = repository();

    await expect(repo.write(makeEntry({ owner: THEIRS }))).rejects.toThrow(ConflictError);
    await expect(repo.readAll()).resolves.toStrictEqual([]);
  });

  it('hands out a fresh array, so a caller cannot edit the base by editing its answer', async () => {
    const repo = repository();
    await repo.write(makeEntry());

    const first = await repo.readAll();
    (first as unknown[]).length = 0;

    await expect(repo.readAll()).resolves.toHaveLength(1);
  });
});

describe('remove', () => {
  it('deletes what is there and refuses what is not', async () => {
    const repo = repository();
    await repo.write(makeEntry());

    await repo.remove(TerminalId.fromString(TERMINAL_UUID));

    await expect(repo.readAll()).resolves.toStrictEqual([]);
    await expect(repo.remove(ABSENT_ID)).rejects.toThrow(NotFoundError);
  });
});

describe('adopt', () => {
  it('refuses an id it does not hold', async () => {
    await expect(repository().adopt(ABSENT_ID, 0)).rejects.toThrow(NotFoundError);
  });

  it('refuses an expectation that no longer matches', async () => {
    const repo = repository();
    await repo.write(makeEntry({ revision: 3 }));

    await expect(repo.adopt(TerminalId.fromString(TERMINAL_UUID), 2)).rejects.toThrow(ConflictError);
  });

  it('has nothing to adopt even when the expectation holds', async () => {
    // Not a gap: an in-memory base is reachable only from the process that
    // holds it, so every entry in it already belongs to this window, and the
    // aggregate refuses adoption by the current owner. M2's file base is where
    // the operation has something to do.
    const repo = repository();
    await repo.write(makeEntry({ revision: 3 }));

    await expect(repo.adopt(TerminalId.fromString(TERMINAL_UUID), 3)).rejects.toThrow(
      ValidationError
    );
  });
});

describe('watch', () => {
  it('signals a change without describing it', async () => {
    // No delta on purpose: the file watcher behind this in M2 can lose a batch
    // of events, and a listener that trusted a delta would miss whatever was in
    // the lost batch. The only safe reaction is to read again.
    const repo = repository();
    const calls: unknown[][] = [];
    repo.watch((...args: unknown[]) => {
      calls.push(args);
    });

    await repo.write(makeEntry());
    await repo.remove(TerminalId.fromString(TERMINAL_UUID));

    expect(calls).toStrictEqual([[], []]);
  });

  it('stops signalling once the subscription is disposed', async () => {
    const repo = repository();
    let seen = 0;
    const subscription = repo.watch(() => {
      seen += 1;
    });

    await repo.write(makeEntry());
    subscription.dispose();
    await repo.write(makeEntry());

    expect(seen).toBe(1);
  });

  it('lets a listener throw, with the base already updated', async () => {
    // Swallowing it would be a silent drop with nowhere to report it: this
    // class has no logger and should not acquire one.
    const repo = repository();
    repo.watch(() => {
      throw new Error('listener is broken');
    });

    await expect(repo.write(makeEntry())).rejects.toThrow('listener is broken');
    await expect(repo.readAll()).resolves.toHaveLength(1);
  });
});

describe('the owner it was constructed with', () => {
  it('is the only one whose entries it will take', async () => {
    const repo = new InMemoryTerminalRepository(THEIRS);
    const theirs = makeEntry({ owner: THEIRS });

    await repo.write(theirs);

    await expect(repo.readOwn(OwnerId.fromString('window-activation-2'))).resolves.toStrictEqual([
      theirs,
    ]);
    await expect(repo.write(makeEntry())).rejects.toThrow(ConflictError);
  });
});
