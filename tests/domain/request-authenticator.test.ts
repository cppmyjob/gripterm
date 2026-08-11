import {
  RequestAuthenticator,
  ValidationError,
  newActivationToken,
} from '../../packages/core/src/index';
import { captureError } from '../helpers/domain-fixtures';

/**
 * The oracle for the one thing standing between a local port and this window's
 * conversations.
 *
 * The port is on loopback, which narrows the attacker to processes already on
 * this machine -- and that is exactly the population a token is for: any of
 * them can connect, so anything not holding the token must be turned away
 * before it has cost us a byte of memory.
 *
 * What is NOT asserted here, said out loud rather than implied: that the
 * comparison takes constant time. No test in this suite can see a timing
 * channel, and one that measured wall-clock would be flaky rather than
 * truthful. What IS asserted is the observable consequence of doing it right --
 * a wrong token of a DIFFERENT length is rejected instead of throwing, which is
 * what `timingSafeEqual` does when it is handed unequal buffers. That kills the
 * likely regression (dropping the digest step); the constant-time property
 * itself is held by review and recorded in §8.2.
 */

const TOKEN = 'f'.repeat(64);

function authenticator(token = TOKEN): RequestAuthenticator {
  return new RequestAuthenticator(token);
}

describe('newActivationToken', () => {
  it('is 32 bytes of randomness, spelled in hex', () => {
    expect(newActivationToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs between activations', () => {
    const tokens = new Set(Array.from({ length: 16 }, () => newActivationToken()));
    expect(tokens.size).toBe(16);
  });
});

describe('RequestAuthenticator accepts', () => {
  it('the bearer scheme carrying its own token', () => {
    expect(authenticator().isAuthorised(`Bearer ${TOKEN}`)).toBe(true);
  });

  it('the scheme in any case, because HTTP says schemes are case-insensitive', () => {
    expect(authenticator().isAuthorised(`bearer ${TOKEN}`)).toBe(true);
    expect(authenticator().isAuthorised(`BEARER ${TOKEN}`)).toBe(true);
  });
});

describe('RequestAuthenticator rejects', () => {
  const REJECTED: readonly (readonly [string, string | undefined])[] = [
    ['no header at all', undefined],
    ['an empty header', ''],
    ['the scheme with nothing after it', 'Bearer'],
    ['the scheme with a blank token', 'Bearer '],
    ['a token with no scheme', TOKEN],
    ['a different scheme', `Basic ${TOKEN}`],
    // Same length, so a comparison that only checked length would let it in.
    ['a wrong token of the same length', `Bearer ${'e'.repeat(64)}`],
    // Different length: `timingSafeEqual` THROWS on unequal buffers, so this is
    // the case that fails loudly when the digest step is dropped.
    ['a wrong token that is shorter', `Bearer ${'f'.repeat(63)}`],
    ['a wrong token that is longer', `Bearer ${'f'.repeat(65)}`],
    ['the right token with the wrong case', `Bearer ${TOKEN.toUpperCase()}`],
    ['the right token with trailing space', `Bearer ${TOKEN} `],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
  ];

  it.each(REJECTED)('%s', (_label, header) => {
    expect(authenticator().isAuthorised(header)).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    // A throw inside a request handler is a 500 and a stack trace; every one of
    // these must be an ordinary `false`.
    for (const [, header] of REJECTED) {
      expect(() => authenticator().isAuthorised(header)).not.toThrow();
    }
  });
});

describe('RequestAuthenticator refuses to be built without a secret', () => {
  it.each(['', '   '])('rejects the blank token %j', (token) => {
    // An authenticator holding an empty token would accept `Bearer ` from
    // anyone -- and `Bearer ` is exactly what the CLI sends when
    // `allowedEnvVars` is missing from the settings file (§2.1a). The two
    // defects would cancel out into a wide-open port that tests green.
    expect(captureError(() => new RequestAuthenticator(token))).toBeInstanceOf(ValidationError);
  });
});
