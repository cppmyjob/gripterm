import type * as vscode from 'vscode';
import { DETAILS_EVENT_LIMIT, HookEventParser, TerminalId, describeTerminal, readJournalTail } from '@gripterm/core';
import type {
  AnnouncingJournal,
  DetailsView,
  HistoryEvent,
  JournalHistory,
  Logger,
  SessionRegistry,
  StorageLayout,
} from '@gripterm/core';
import type { TerminalStage } from './terminal-stage';
import type { WorkbenchView } from './workbench-view';

/**
 * The details half of the panel: what this build knows about the terminal on
 * screen, kept up to date and never polled.
 *
 * Like the strip, it owns no state about terminals and adds no opinion of its
 * own. The STAGE knows which terminal is on screen and which still have a
 * process, the REGISTRY knows what each of them is and is doing, the JOURNAL
 * holds what has happened to them, and `describeTerminal` in the core turns the
 * three into a half -- through `presentTerminal`, the same rule the tree and the
 * strip draw with, so one terminal cannot be `working` on its tab and `idle`
 * beside it.
 *
 * **Two signals, and neither of them is a clock.**
 *
 *   * the REGISTRY's, for the record: a state, a tool, a task, a note. It is the
 *     same signal the tree redraws on, which is the plan's own line for this
 *     half.
 *   * the JOURNAL's, for the history, and it has to be its own. A delivery
 *     reaches the journal and the registry in the same breath, but only one of
 *     them takes a round trip to a file -- so a half that re-read the history on
 *     the registry's signal would read the file just before the newest line
 *     lands in it, and would show a history permanently one event behind. The
 *     journal says when the write has landed (`AnnouncingJournal`), and that is
 *     when the tail is read again.
 *
 * **The read is bounded and coalesced.** Bounded, because it happens again on
 * every event that reaches the terminal a person is watching (`readJournalTail`
 * reads the end of a file, never the whole history). Coalesced, because a burst
 * of events would otherwise start a burst of reads: one is in flight at a time,
 * and a signal that arrives during it is remembered as "read again when this
 * one is done" rather than queued.
 */

export interface TerminalDetailsOptions {
  readonly view: WorkbenchView;
  readonly stage: TerminalStage;
  readonly registry: SessionRegistry;
  readonly storage: StorageLayout;
  readonly journal: AnnouncingJournal;
  readonly logger: Logger;
}

/** What the half says about a terminal whose history it has not read yet. */
const UNREAD: JournalHistory = {
  events: [],
  gaps: 0,
  unreadableLines: 0,
  unreadableFiles: 0,
  read: false,
};

export class TerminalDetails implements vscode.Disposable {
  private readonly _options: TerminalDetailsOptions;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _parser = new HookEventParser();
  /** The terminal the half is about: the stage's answer, remembered to notice a change. */
  private _shown: string | null = null;
  private _history: JournalHistory = UNREAD;
  private _drawn: DetailsView | null = null;
  /** What was last SENT, as text, so that a signal changing nothing sends nothing. */
  private _sent: string | null = null;
  private _reading = false;
  /** A signal that arrived while a read was in flight. */
  private _again = false;
  private _reads = 0;
  /** Why the last read happened. In the object rather than the log: a suite reads objects. */
  private _lastRead: string | null = null;

  constructor(options: TerminalDetailsOptions) {
    this._options = options;
    this._shown = options.stage.activeTerminal;
    this._subscriptions.push(
      options.stage.onChanged(() => { this._staged(); }),
      options.registry.subscribe(() => { this._draw(); }),
      options.journal.subscribe((terminalId) => {
        if (terminalId.value === this._shown) {
          void this._read('the journal wrote a line for the terminal on screen');
        }
      }),
      options.view.onMessage((message) => {
        if (message.kind === 'ready') {
          // A page that was thrown away and rebuilt has an empty half and no
          // idea what was in it. Nothing about the terminals changed, so the
          // ordinary path would send nothing at all -- and the half would stay
          // blank until the next event in somebody's conversation.
          this._sent = null;
          this._draw();
        }
      })
    );
    this._draw();
    void this._read('the window opened');
  }

  /** The half as this window last drew it. What the suite reads instead of a screenshot. */
  public get drawn(): DetailsView | null {
    return this._drawn;
  }

  /**
   * How many times the history has been read off the disk.
   *
   * Exposed because "it does not poll" is otherwise unfalsifiable from the host
   * side: a number that stands still while nothing happens is the difference
   * between following a signal and asking on a timer.
   */
  public get reads(): number {
    return this._reads;
  }

  /** What made the half read the journal last. `null` before it ever has. */
  public get lastRead(): string | null {
    return this._lastRead;
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
  }

  /**
   * The stage moved: a terminal was shown, taken away, or its process ended.
   *
   * A NEW terminal on screen throws the history away rather than leaving the
   * old one up while the next is read: an event list belonging to another agent
   * is worse than an empty one, and the half says it is reading.
   */
  private _staged(): void {
    const shown = this._options.stage.activeTerminal;
    if (shown === this._shown) {
      this._draw();
      return;
    }
    this._shown = shown;
    this._history = UNREAD;
    this._draw();
    void this._read('the panel showed another terminal');
  }

  /**
   * Draws the half, and only when there is something new in it.
   *
   * The signals this listens to are not all about this terminal: the registry
   * says something every time the shared base is re-read, which happens on a
   * timer of its own and usually changes nothing here -- measured at two
   * redraws in a second and a half of an idle window (2026-08-18). A half
   * redrawn for that is a message across the channel and a document rebuilt for
   * the same words.
   *
   * So what is compared is the OUTCOME rather than the signal, and the promise
   * the plan makes -- the half follows the registry and does not poll -- becomes
   * a number that stands still while nothing happens.
   */
  private _draw(): void {
    const { stage, registry, view } = this._options;
    const next = describeTerminal({
      held: stage.held,
      running: stage.running,
      shown: stage.activeTerminal,
      // This window's own records only, as the strip does: a record projected in
      // from another window has no terminal on this panel to be about.
      entries: registry.own(),
      history: this._history,
    });
    this._drawn = next;
    const asText = JSON.stringify(next);
    if (asText === this._sent) {
      return;
    }
    this._sent = asText;
    view.post({ kind: 'details', view: next });
  }

  private async _read(because: string): Promise<void> {
    if (this._reading) {
      this._again = true;
      return;
    }
    const asked = this._shown;
    if (asked === null) {
      return;
    }
    const terminalId = TerminalId.tryFromString(asked);
    if (terminalId === null) {
      // The panel is holding something that is not a terminal id. It has a tab
      // and a screen, so it is said out loud rather than left as an empty half.
      this._options.logger.warn('the panel is showing something that is not a terminal', {
        terminalId: asked,
      });
      return;
    }

    this._reading = true;
    try {
      const tail = await readJournalTail(this._options.storage, terminalId, DETAILS_EVENT_LIMIT);
      this._reads += 1;
      this._lastRead = because;
      if (this._shown !== asked) {
        // A person switched terminals while the disk was being read. The lines
        // belong to the terminal that WAS shown, and drawing them now would put
        // one agent's history under another agent's name.
        return;
      }
      if (tail.unreadableFiles.length > 0) {
        // Counted in the half, named in the log: somebody has to be able to go
        // and look at the file, and a panel is not where a path belongs.
        this._options.logger.warn('part of a terminal history could not be read', {
          terminalId: asked,
          files: tail.unreadableFiles,
        });
      }
      this._history = {
        events: tail.lines.map((line) => this._historyEvent(line.at, line.payload, line.dropped)),
        gaps: tail.gaps.length,
        unreadableLines: tail.unreadableLines,
        unreadableFiles: tail.unreadableFiles.length,
        read: true,
      };
      this._draw();
    } catch (cause: unknown) {
      // A history that cannot be read is not a window that stops working. The
      // half keeps whatever it had, and the reason goes where reasons go.
      this._options.logger.error('a terminal history could not be read', {
        terminalId: asked,
        cause,
      });
    } finally {
      this._reading = false;
      if (this._again) {
        this._again = false;
        void this._read(`${because}, and another arrived while it was being read`);
      }
    }
  }

  /**
   * One journal line as the rule wants it.
   *
   * The parser is the SAME one the registry observes with, which is what makes
   * the half's words and the row's state two readings of one event rather than
   * two guesses. A line it refuses is carried across as an event of `null`: the
   * rule draws it as unreadable, because a history that silently omits what this
   * build cannot parse is a history nobody can act on -- and those lines are the
   * ones worth having, since they are the ones whose contract changed under us.
   */
  private _historyEvent(at: Date, payload: unknown, dropped: readonly string[]): HistoryEvent {
    const parsed = this._parser.parse(payload);
    return {
      atMs: at.getTime(),
      event: parsed.status === 'parsed' ? parsed.event : null,
      dropped,
    };
  }
}
