import { ListeningAddress, ValidationError } from '../../packages/core/src/index';
import { captureError } from '../helpers/domain-fixtures';

/**
 * The address is the one literal in `settings.json` that cannot be interpolated
 * from the environment -- `$VAR` substitution reaches header values only, never
 * the URL [measured, binary 2.1.224]. So a wrong address is not a wrong string:
 * it is an observation channel that dies silently, since a hook failure is
 * non-blocking and the CLI carries on.
 */

describe('ListeningAddress', () => {
  it('binds to loopback and nothing else', () => {
    expect(ListeningAddress.loopback(51_337).host).toBe('127.0.0.1');
  });

  it('spells the origin the way a URL parser reads it back', () => {
    const address = ListeningAddress.loopback(51_337);

    expect(address.origin).toBe('http://127.0.0.1:51337');
    expect(new URL(address.origin).port).toBe('51337');
  });

  it.each([
    ['zero -- an unbound server, not an ephemeral one', 0],
    ['negative', -1],
    ['fractional', 8080.5],
    ['above the 16-bit range', 65_536],
    ['not a number at all', Number.NaN],
  ])('refuses a port that is %s', (_why, port) => {
    const error = captureError(() => ListeningAddress.loopback(port));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toStrictEqual({ port });
  });

  it.each([1, 65_535])('accepts the end of the range: %i', (port) => {
    expect(ListeningAddress.loopback(port).port).toBe(port);
  });

  it('compares by port, not by identity', () => {
    const address = ListeningAddress.loopback(51_337);

    expect(address.equals(ListeningAddress.loopback(51_337))).toBe(true);
    expect(address.equals(ListeningAddress.loopback(51_338))).toBe(false);
  });

  it('cannot be moved after it is built', () => {
    const address = ListeningAddress.loopback(51_337);

    expect(() => {
      (address as unknown as { port: number }).port = 1;
    }).toThrow(TypeError);
  });
});
