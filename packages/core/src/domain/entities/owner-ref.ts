import { ValidationError } from '../errors/gripterm-error';
import type { OwnerId } from './owner-id';

/**
 * `'window'` throughout the MVP, and no branch reads it otherwise. It exists
 * now because it is what will later let an orchestrator own background sessions
 * with no editor window open -- one field today against rewriting the ownership
 * rules and migrating every record tomorrow.
 */
export type OwnerKind = 'window' | 'service';

export type EditorKind = 'vscode' | 'cursor' | 'unknown' | 'none';

export interface OwnerRefParams {
  readonly kind: OwnerKind;
  readonly ownerId: OwnerId;
  readonly editorKind: EditorKind;
  readonly workspaceFolder: string | null;
}

/**
 * Who may write this record. The field decides three separate things -- write
 * permission, how the list groups in the UI, and what happens to a record whose
 * owner died -- which is why it is introduced up front rather than when first
 * needed.
 */
export class OwnerRef {
  public readonly kind: OwnerKind;
  public readonly ownerId: OwnerId;
  public readonly editorKind: EditorKind;

  /** The project this terminal belongs to; `null` when the host has no folder open. */
  public readonly workspaceFolder: string | null;

  private constructor(params: OwnerRefParams) {
    this.kind = params.kind;
    this.ownerId = params.ownerId;
    this.editorKind = params.editorKind;
    this.workspaceFolder = params.workspaceFolder;
    Object.freeze(this);
  }

  public static create(params: OwnerRefParams): OwnerRef {
    if (params.workspaceFolder !== null && params.workspaceFolder.trim().length === 0) {
      throw new ValidationError('workspaceFolder must be a path or null, never blank', {
        details: { workspaceFolder: params.workspaceFolder },
      });
    }
    return new OwnerRef(params);
  }

  public equals(other: OwnerRef): boolean {
    return (
      this.kind === other.kind &&
      this.ownerId.equals(other.ownerId) &&
      this.editorKind === other.editorKind &&
      this.workspaceFolder === other.workspaceFolder
    );
  }
}
