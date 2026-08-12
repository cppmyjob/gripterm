import { ValidationError } from '../errors/gripterm-error';
import type { Note } from './note';

export interface HumanMetadataParams {
  readonly displayName: string;
  readonly task: string | null;
  readonly notes: readonly Note[];
  readonly tags: readonly string[];
  /** A theme colour id, e.g. `terminal.ansiCyan`. `null` leaves the host's default. */
  readonly color: string | null;
}

/**
 * Everything about a terminal that a person put there. Claude Code never writes
 * any of it, and nothing can reconstruct it from events -- which is exactly why
 * it lives apart from `ObservedState`, whose loss costs nothing.
 */
export class HumanMetadata {
  public readonly displayName: string;
  public readonly task: string | null;
  public readonly notes: readonly Note[];
  public readonly tags: readonly string[];
  public readonly color: string | null;

  private constructor(params: HumanMetadataParams) {
    this.displayName = params.displayName;
    this.task = params.task;
    // Copied, then frozen. `readonly string[]` is a promise to the compiler
    // only: the caller keeps a reference to the array it passed in and could
    // push to it afterwards, and `entry.metadata.tags.push(...)` would
    // otherwise be a silent mutation of a "frozen" object.
    this.notes = Object.freeze([...params.notes]);
    this.tags = Object.freeze([...params.tags]);
    this.color = params.color;
    Object.freeze(this);
  }

  public static create(params: HumanMetadataParams): HumanMetadata {
    const displayName = params.displayName.trim();
    if (displayName.length === 0) {
      throw new ValidationError('displayName must not be blank', {
        details: { displayName: params.displayName },
      });
    }

    const tags: string[] = [];
    for (const tag of params.tags) {
      const trimmed = tag.trim();
      if (trimmed.length === 0) {
        throw new ValidationError('a tag must not be blank', { details: { tags: params.tags } });
      }
      // A repeated tag says nothing twice; keeping it would make two equal
      // metadata objects compare unequal on the order of insertion alone.
      if (!tags.includes(trimmed)) {
        tags.push(trimmed);
      }
    }

    return new HumanMetadata({ ...params, displayName, tags });
  }

  /**
   * The name in the list. Blank is refused rather than normalised: a row with
   * no name is a row nobody can point at, and the caller asking for one has a
   * person in front of it who can be told.
   */
  public withDisplayName(next: string): HumanMetadata {
    return this._with({ displayName: next });
  }

  /**
   * What this terminal is FOR, or nothing.
   *
   * Blank collapses to `null`, and that is the difference from a name: an empty
   * task is a task nobody set, and storing `''` would make "has a task" a
   * question with two right answers -- one of which every reader would have to
   * remember to ask.
   */
  public withTask(next: string | null): HumanMetadata {
    return this._with({ task: blankToNull(next) });
  }

  /** Appends. Notes are a log of what a person thought, not a field to overwrite. */
  public withNote(note: Note): HumanMetadata {
    return this._with({ notes: [...this.notes, note] });
  }

  public withTags(next: readonly string[]): HumanMetadata {
    return this._with({ tags: next });
  }

  /**
   * A theme colour id, or nothing.
   *
   * Deliberately NOT checked against a list of known ids. The set of theme
   * colours belongs to the editor and grows with it, a record can be written by
   * a build newer than the one reading it, and an unknown id costs exactly the
   * default colour. Refusing one would make this the authority on somebody
   * else's list, and would turn a cosmetic disagreement into a record that
   * cannot be read.
   */
  public withColor(next: string | null): HumanMetadata {
    return this._with({ color: blankToNull(next) });
  }

  public equals(other: HumanMetadata): boolean {
    return (
      this.displayName === other.displayName &&
      this.task === other.task &&
      this.color === other.color &&
      this.tags.length === other.tags.length &&
      this.tags.every((tag, index) => tag === other.tags[index]) &&
      this.notes.length === other.notes.length &&
      this.notes.every((note, index) => {
        const counterpart = other.notes[index];
        return counterpart !== undefined && note.equals(counterpart);
      })
    );
  }

  /**
   * Every mutator goes through `create`, so a change is validated by the same
   * rule as a construction. The alternative -- assigning into a copy -- is how
   * an object acquires a state its constructor would have refused.
   */
  private _with(changes: Partial<HumanMetadataParams>): HumanMetadata {
    return HumanMetadata.create({
      displayName: this.displayName,
      task: this.task,
      notes: this.notes,
      tags: this.tags,
      color: this.color,
      ...changes,
    });
  }
}

function blankToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
