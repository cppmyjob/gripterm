import { LAUNCH_LOCATIONS, isLaunchLocation } from '../../packages/core/src/index';

describe('where a terminal is opened', () => {
  it('offers exactly three places, with the strip of our own first', () => {
    // The order is the manifest's default: a list whose first member is not the
    // default is a trap for the next person to read either file.
    expect(LAUNCH_LOCATIONS).toEqual(['group', 'editor', 'panel']);
  });

  it('recognises all three', () => {
    expect(isLaunchLocation('group')).toBe(true);
    expect(isLaunchLocation('editor')).toBe(true);
    expect(isLaunchLocation('panel')).toBe(true);
  });

  it('refuses anything else, so a typo in settings.json is reported rather than obeyed', () => {
    expect(isLaunchLocation('Editor')).toBe(false);
    expect(isLaunchLocation('sidebar')).toBe(false);
    expect(isLaunchLocation('')).toBe(false);
  });
});
