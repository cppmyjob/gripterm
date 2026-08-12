import {
  asArray,
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
  asStringMap,
} from '../../packages/core/src/index';

/**
 * The project's answer to "what counts as a string", in one place so that two
 * copies cannot come to disagree.
 *
 * Every one of these is total over `unknown`: the inputs below deliberately
 * include the values a `JSON.parse` never produces but a caller can still hand
 * over -- `undefined`, `NaN`, a function -- because totality that holds only
 * for well-formed input is not totality.
 */

const NOT_VALUES: readonly unknown[] = [undefined, null, Number.NaN, () => 0, Symbol('x')];

describe('reading untrusted JSON', () => {
  it('sees an object, and does not mistake an array for one', () => {
    expect(asRecord({ a: 1 })).toStrictEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    for (const value of NOT_VALUES) {
      expect(asRecord(value)).toBeNull();
    }
  });

  it('sees a string, including an empty one', () => {
    expect(asString('')).toBe('');
    expect(asString('x')).toBe('x');
    expect(asString(1)).toBeNull();
    expect(asString(['x'])).toBeNull();
  });

  it('sees a boolean, and not a string that spells one', () => {
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('true')).toBeNull();
    expect(asBoolean(1)).toBeNull();
  });

  /*
   * `JSON.stringify` turns `NaN` and the infinities into `null`, so a value that
   * became one on the way IN is already lost. A reader that accepted them would
   * carry the loss further -- as a timestamp that compares false against itself.
   */
  it('sees a number that can be stored, and refuses the three that cannot', () => {
    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(-1.5)).toBe(-1.5);
    expect(asFiniteNumber(Number.NaN)).toBeNull();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber('1')).toBeNull();
  });

  it('sees an array of anything', () => {
    expect(asArray([])).toStrictEqual([]);
    expect(asArray([1, 'a', null])).toStrictEqual([1, 'a', null]);
    expect(asArray({ length: 0 })).toBeNull();
    expect(asArray('ab')).toBeNull();
  });

  it('sees an array of strings, and refuses one with a single stranger in it', () => {
    expect(asStringArray([])).toStrictEqual([]);
    expect(asStringArray(['a', 'b'])).toStrictEqual(['a', 'b']);
    expect(asStringArray(['a', 1])).toBeNull();
    expect(asStringArray('a')).toBeNull();
  });

  /*
   * The whole map is refused on the first value that is not a string, rather
   * than that entry being dropped: a launch recipe missing one variable starts a
   * terminal that behaves almost right, which is harder to diagnose than one
   * that refuses.
   */
  it('sees a map of strings, all or nothing', () => {
    expect(asStringMap({})).toStrictEqual({});
    expect(asStringMap({ A: '1', B: '2' })).toStrictEqual({ A: '1', B: '2' });
    expect(asStringMap({ A: '1', B: 2 })).toBeNull();
    expect(asStringMap(['a'])).toBeNull();
    expect(asStringMap(null)).toBeNull();
  });
});
