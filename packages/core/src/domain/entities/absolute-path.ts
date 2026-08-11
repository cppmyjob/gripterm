import { posix, win32 } from 'node:path';
import { ValidationError } from '../errors/gripterm-error';

/**
 * Refuses a relative path, and accepts BOTH spellings of absolute rather than
 * the host platform's own.
 *
 * The reason is not portability in the abstract. Every caller here is writing a
 * path into something another process will read -- a settings file, an argument
 * vector -- and a hook or a launch runs with the TERMINAL's environment, not the
 * editor's, whose working directory and PATH we do not control (C5-2). A
 * relative path resolved against the wrong directory does not fail loudly: it
 * fails as a hook that never fires, or a launch that starts an unobserved agent.
 */
export function requireAbsolutePath(value: string, field: string): string {
  if (!win32.isAbsolute(value) && !posix.isAbsolute(value)) {
    throw new ValidationError(`${field} must be an absolute path`, {
      details: { field, value },
    });
  }
  return value;
}
