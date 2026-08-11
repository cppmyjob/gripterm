import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../errors/gripterm-error';

/** 32 bytes. Long enough that guessing is not a strategy, short enough to sit in an env var. */
const TOKEN_BYTES = 32;

const BEARER = 'bearer ';

/**
 * One secret per activation, held in memory and never written to disk.
 *
 * Per ACTIVATION and not per install: it travels to the CLI in the terminal's
 * environment, alongside a port that also belongs to this activation, and the
 * two are only meaningful together (§4.7). A token that outlived the window
 * that issued it would be a credential with no owner.
 */
export function newActivationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Decides whether a request came from a terminal we started.
 *
 * The port listens on loopback, so the population that can reach it is "every
 * process on this machine" -- which is precisely why a token is needed and why
 * this check runs before the request body is read. An unauthenticated peer must
 * not be able to make us allocate.
 */
export class RequestAuthenticator {
  private readonly _digest: Buffer;

  constructor(token: string) {
    if (token.trim().length === 0) {
      throw new ValidationError('the activation token must not be blank');
    }
    this._digest = digestOf(token);
  }

  /**
   * Never throws. A throw inside a request handler is a 500 with a stack trace
   * where a plain `false` was meant, and the caller would have no way to tell
   * the two apart.
   */
  public isAuthorised(authorizationHeader: string | undefined): boolean {
    if (authorizationHeader === undefined) {
      return false;
    }
    if (!authorizationHeader.toLowerCase().startsWith(BEARER)) {
      return false;
    }
    const presented = authorizationHeader.slice(BEARER.length);
    if (presented.length === 0) {
      return false;
    }
    // Both sides are hashed FIRST, and that is not decoration. `timingSafeEqual`
    // throws when the two buffers differ in length, so comparing the raw strings
    // would turn a wrong-length token into an exception -- and would leak the
    // right length through the difference between an exception and a `false`.
    // Digests are always 32 bytes, so the comparison is total.
    return timingSafeEqual(this._digest, digestOf(presented));
  }
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
