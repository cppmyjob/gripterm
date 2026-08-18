import { AnnouncingJournal, TerminalId } from '../../packages/core/src/index';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';
import type { EventJournal, HookDelivery } from '../../packages/core/src/index';

/**
 * The signal the details half of the panel follows.
 *
 * Every line here is about the ORDER of two things: the write and the word that
 * it happened. A reader told too early finds a file without the line in it and
 * shows a history one event behind for ever; a reader told after a failure
 * re-reads for nothing.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const DELIVERY: HookDelivery = {
  terminalId: TERMINAL,
  receivedAt: new Date('2026-08-18T10:00:00.000Z'),
  raw: '{"hook_event_name":"Stop"}',
};

/** A journal whose write can be held open, so the order can be watched. */
class HeldJournal implements EventJournal {
  public written = 0;
  private _release: (() => void) | null = null;

  public async append(): Promise<void> {
    this.written += 1;
    await new Promise<void>((resolve) => {
      this._release = resolve;
    });
  }

  public finish(): void {
    this._release?.();
  }
}

describe('a journal that says when it has written', () => {
  it('says so, and names the terminal it wrote about', async () => {
    const heard: string[] = [];
    const journal = new AnnouncingJournal({ append: async () => { /* landed */ } });
    journal.subscribe((terminalId) => { heard.push(terminalId.value); });

    await journal.append(DELIVERY);

    expect(heard).toStrictEqual([TERMINAL_UUID]);
  });

  it('says nothing until the write has landed', async () => {
    const held = new HeldJournal();
    const journal = new AnnouncingJournal(held);
    let heard = 0;
    journal.subscribe(() => { heard += 1; });

    const writing = journal.append(DELIVERY);
    await Promise.resolve();
    expect(held.written).toBe(1);
    expect(heard).toBe(0);

    held.finish();
    await writing;
    expect(heard).toBe(1);
  });

  it('says nothing at all about a write that failed', async () => {
    const journal = new AnnouncingJournal({
      append: async () => { throw new Error('the disk is full'); },
    });
    let heard = 0;
    journal.subscribe(() => { heard += 1; });

    await expect(journal.append(DELIVERY)).rejects.toThrow('the disk is full');
    expect(heard).toBe(0);
  });

  it('stops telling a listener that has gone', async () => {
    const journal = new AnnouncingJournal({ append: async () => { /* landed */ } });
    let heard = 0;
    const subscription = journal.subscribe(() => { heard += 1; });

    await journal.append(DELIVERY);
    subscription.dispose();
    await journal.append(DELIVERY);

    expect(heard).toBe(1);
  });
});
