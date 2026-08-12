import { Note } from '../entities/note';
import type { Clock } from '../ports/clock';
import type { HumanMetadata } from '../entities/human-metadata';
import type { Logger } from '../ports/logger';
import type { SessionRegistry } from './session-registry';
import type { TerminalId } from '../entities/terminal-id';

/** What an input box says when a name would be blank. */
export const NAME_REQUIRED = 'A terminal needs a name.';

/** What an input box says when a note would be blank. */
export const NOTE_REQUIRED = 'A note needs some text.';

/** Whether text a person typed is nothing at all. Blank means blank, not empty. */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** One entry in the colour picker. */
export interface ColorChoice {
  /** The theme colour id stored in the record, e.g. `terminal.ansiCyan`. */
  readonly id: string;
  /** What it is called in front of a person. */
  readonly label: string;
}

/**
 * The colours a person may paint a row with.
 *
 * The `terminal.ansi*` family rather than the `charts.*` one the state icons
 * use, and that is the whole point of choosing a family at all: the two must not
 * be confusable. A row painted `charts.yellow` beside an icon painted
 * `charts.yellow` reads as a state, and the state is the one thing on that row
 * this extension is responsible for being right about.
 *
 * Black and white are absent. Both exist in every theme and both are invisible
 * in half of them, which makes "I set a colour and nothing happened" a support
 * question with a correct answer nobody can guess.
 */
export const TERMINAL_COLORS: readonly ColorChoice[] = [
  { id: 'terminal.ansiCyan', label: 'Cyan' },
  { id: 'terminal.ansiBlue', label: 'Blue' },
  { id: 'terminal.ansiMagenta', label: 'Magenta' },
  { id: 'terminal.ansiGreen', label: 'Green' },
  { id: 'terminal.ansiYellow', label: 'Yellow' },
  { id: 'terminal.ansiRed', label: 'Red' },
];

const TAG_SEPARATOR = ',';

/**
 * Tags out of one line of typing.
 *
 * Commas and nothing else. Splitting on spaces as well was considered and
 * dropped: `code review` is a tag somebody means, and a rule that quietly turned
 * it into two would be a rule they could not see, switch off, or work around.
 *
 * Blanks are dropped rather than refused, because the input this parses is
 * `one, , two` -- a person mid-edit, not a mistake worth a dialog about.
 */
export function parseTags(input: string): readonly string[] {
  const tags: string[] = [];
  for (const part of input.split(TAG_SEPARATOR)) {
    const tag = part.trim();
    // Deduplicated here as well as in `HumanMetadata`, so that the box a person
    // reopens shows what they will get rather than what they typed.
    if (tag.length > 0 && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

/** The inverse, for prefilling the box: what is there now, editable as text. */
export function formatTags(tags: readonly string[]): string {
  return tags.join(`${TAG_SEPARATOR} `);
}

export interface TerminalMetadataOptions {
  readonly registry: SessionRegistry;
  /** For a note's timestamp, which is the only thing here that is not a person's word. */
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Everything a person changes about a record of their own: its name, what it is
 * for, what they thought about it, how it is filed and what colour it is.
 *
 * One object rather than five commands doing `get` then `amend`, and the reason
 * is where the commands live: `packages/extension` is outside the coverage
 * thresholds (§3.5), so a rule written there is a rule nothing checks. Three
 * rules are written here once instead of five times:
 *
 *   * **only a record this window holds.** `registry.get` answers for our own
 *     and never for what the base projected in, so a person cannot edit another
 *     window's terminal by finding it in a picker -- which would be a write into
 *     a file this window is forbidden to write (§4.8);
 *   * **a record that is gone is not an error.** Between the picker opening and
 *     the person choosing, a terminal can be deleted in another window and the
 *     projection can drop it. A dialog about that would interrupt somebody to
 *     report something they cannot act on;
 *   * **a change that changes nothing is not a change.** Opening the rename box
 *     and pressing Enter must not redraw the tree, must not queue a write and
 *     must not touch `record.json`.
 *
 * Nothing here writes. `amend` notifies, `BaseWriter` hears it and stores it
 * (M2.6) -- which is why an edit made while the store is unreachable still shows
 * on screen, and why there is exactly one road from an edit to the disk.
 */
export class TerminalMetadataService {
  constructor(private readonly _options: TerminalMetadataOptions) {}

  /**
   * The name in the list, and only there.
   *
   * It does NOT rename the editor's terminal tab: the platform offers no way to
   * rename a terminal after it has been created, and the name it was given at
   * launch is the name it keeps until it closes. Said out loud because the two
   * names then disagree on screen, which looks like a bug and is a limit.
   */
  public rename(terminalId: TerminalId, displayName: string): void {
    if (this._refuseBlank(terminalId, displayName, 'a rename')) {
      return;
    }
    this._apply(terminalId, (metadata) => metadata.withDisplayName(displayName));
  }

  /** What the terminal is for. `null` -- or blank -- clears it. */
  public setTask(terminalId: TerminalId, task: string | null): void {
    this._apply(terminalId, (metadata) => metadata.withTask(task));
  }

  /**
   * Appends a note, stamped now.
   *
   * There is no way to remove one, and that is a named limit rather than an
   * oversight: the record can be deleted whole, and a second command to edit a
   * list of lines is a milestone of its own. It is written down in §8.2 so that
   * the first person to want it finds the answer instead of the absence.
   */
  public addNote(terminalId: TerminalId, text: string): void {
    if (this._refuseBlank(terminalId, text, 'a note')) {
      return;
    }
    const note = Note.create(this._options.clock.now(), text);
    this._apply(terminalId, (metadata) => metadata.withNote(note));
  }

  public setTags(terminalId: TerminalId, tags: readonly string[]): void {
    this._apply(terminalId, (metadata) => metadata.withTags(tags));
  }

  /** A theme colour id from `TERMINAL_COLORS`, or `null` for the theme's own. */
  public setColor(terminalId: TerminalId, colorId: string | null): void {
    this._apply(terminalId, (metadata) => metadata.withColor(colorId));
  }

  /**
   * Blank text, refused with a sentence in the log rather than with a throw.
   *
   * The commands validate in the input box, so this is a path a person cannot
   * take. It exists because the alternative to refusing is `HumanMetadata`
   * throwing out of a command handler, which the editor reports as the extension
   * having crashed -- and a defence that turns a typo into that is worse than
   * the typo.
   */
  private _refuseBlank(terminalId: TerminalId, text: string, what: string): boolean {
    if (!isBlank(text)) {
      return false;
    }
    this._options.logger.warn('blank text was offered where text is required, and was refused', {
      terminalId: terminalId.value,
      what,
    });
    return true;
  }

  private _apply(
    terminalId: TerminalId,
    change: (metadata: HumanMetadata) => HumanMetadata
  ): void {
    const entry = this._options.registry.get(terminalId);
    if (entry === undefined) {
      this._options.logger.info('an edit named a terminal this window does not hold', {
        terminalId: terminalId.value,
      });
      return;
    }

    const next = change(entry.metadata);
    if (next.equals(entry.metadata)) {
      return;
    }
    this._options.registry.amend(entry.withMetadata(next));
  }
}
