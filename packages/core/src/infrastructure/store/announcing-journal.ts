import type { Disposable } from '../../domain/ports/disposable';
import type { EventJournal } from '../../domain/ports/event-journal';
import type { HookDelivery } from '../../domain/entities/hook-delivery';
import type { TerminalId } from '../../domain/entities/terminal-id';

/**
 * A journal that says when it has written something.
 *
 * It exists because of the order two consumers are served in. A delivery is
 * handed to the journal and to the registry in the same breath, and the journal
 * is the one that takes a file system round trip -- so a reader woken by the
 * REGISTRY's signal reads the file before the newest line is in it, and shows a
 * history that is permanently one event behind. That is not a delay a person
 * forgives: the event they are looking for is the one that just happened.
 *
 * So the announcement is made AFTER the write landed, and not at all when it
 * failed: a reader told about a line that was never written would find nothing
 * and re-read for nothing. Nobody is told what was written, only about which
 * terminal -- a listener that wanted the line can go and read it, and one that
 * does not is spared a copy of a payload this build may not even be able to
 * parse.
 *
 * A decorator rather than a callback inside `FileEventJournal`, because the two
 * things are separate: one owns a file, the other owns a list of listeners, and
 * a writer whose test had to drain a listener list would be two tests in one.
 */
export class AnnouncingJournal implements EventJournal {
  private readonly _inner: EventJournal;
  private readonly _listeners = new Set<(terminalId: TerminalId) => void>();

  constructor(inner: EventJournal) {
    this._inner = inner;
  }

  public async append(delivery: HookDelivery): Promise<void> {
    await this._inner.append(delivery);
    for (const listener of this._listeners) {
      listener(delivery.terminalId);
    }
  }

  public subscribe(listener: (terminalId: TerminalId) => void): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }
}
