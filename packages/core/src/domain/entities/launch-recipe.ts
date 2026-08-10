import { ValidationError } from '../errors/gripterm-error.js';
import type { PermissionMode } from './permission-mode.js';

export interface LaunchRecipeParams {
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly permissionMode: PermissionMode | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly worktree: string | null;
  readonly mcpConfigPaths: readonly string[];
  readonly appendSystemPrompt: string | null;
  readonly extraEnv: Readonly<Record<string, string>>;
}

/**
 * The whole recipe for starting this terminal, not just an id to resume.
 *
 * `--resume` restores the conversation and nothing else: not `--settings`, not
 * `--mcp-config`, not `--add-dir`. Storing a session id alone would bring back
 * a terminal with no hooks and no bus -- alive, and blind to us.
 */
export class LaunchRecipe {
  public readonly cwd: string;
  public readonly addDirs: readonly string[];
  public readonly permissionMode: PermissionMode | null;
  public readonly agent: string | null;
  public readonly model: string | null;
  public readonly worktree: string | null;
  public readonly mcpConfigPaths: readonly string[];
  public readonly appendSystemPrompt: string | null;
  public readonly extraEnv: Readonly<Record<string, string>>;

  private constructor(params: LaunchRecipeParams) {
    this.cwd = params.cwd;
    this.addDirs = Object.freeze([...params.addDirs]);
    this.permissionMode = params.permissionMode;
    this.agent = params.agent;
    this.model = params.model;
    this.worktree = params.worktree;
    this.mcpConfigPaths = Object.freeze([...params.mcpConfigPaths]);
    this.appendSystemPrompt = params.appendSystemPrompt;
    this.extraEnv = Object.freeze({ ...params.extraEnv });
    Object.freeze(this);
  }

  public static create(params: LaunchRecipeParams): LaunchRecipe {
    const cwd = params.cwd.trim();
    if (cwd.length === 0) {
      throw new ValidationError('cwd must not be blank', { details: { cwd: params.cwd } });
    }
    for (const dir of params.addDirs) {
      if (dir.trim().length === 0) {
        throw new ValidationError('addDirs must not contain a blank path', {
          details: { addDirs: params.addDirs },
        });
      }
    }
    for (const path of params.mcpConfigPaths) {
      if (path.trim().length === 0) {
        throw new ValidationError('mcpConfigPaths must not contain a blank path', {
          details: { mcpConfigPaths: params.mcpConfigPaths },
        });
      }
    }
    return new LaunchRecipe({ ...params, cwd });
  }
}
