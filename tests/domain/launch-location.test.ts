import { LAUNCH_LOCATIONS, isLaunchLocation } from '../../packages/core/src/index';

describe('where a terminal is opened', () => {
  it('offers exactly two places, with the editor first', () => {
    // The order is the manifest's default: a list whose first member is not the
    // default is a trap for the next person to read either file.
    expect(LAUNCH_LOCATIONS).toEqual(['editor', 'panel']);
  });

  it('recognises both', () => {
    expect(isLaunchLocation('editor')).toBe(true);
    expect(isLaunchLocation('panel')).toBe(true);
  });

  it('refuses anything else, so a typo in settings.json is reported rather than obeyed', () => {
    expect(isLaunchLocation('Editor')).toBe(false);
    expect(isLaunchLocation('sidebar')).toBe(false);
    expect(isLaunchLocation('')).toBe(false);
  });
});
