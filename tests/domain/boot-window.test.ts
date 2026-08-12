import { precedesBoot } from '../../packages/core/src/domain/services/boot-window';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOUR_SECONDS = 3600;
const HOUR_MS = 3_600_000;

describe('telling a moment from before this boot', () => {
  it('calls a moment older than the uptime one from a previous life', () => {
    // Nothing a running process wrote can predate the boot it started after, so
    // this is the whole cross-boot class of pid reuse, removed by arithmetic.
    expect(precedesBoot(NOW - HOUR_MS - 1, NOW, HOUR_SECONDS)).toBe(true);
  });

  it('does not call a moment inside the uptime one from before it', () => {
    expect(precedesBoot(NOW - HOUR_MS + 1, NOW, HOUR_SECONDS)).toBe(false);
  });

  it('reads the boot moment itself as part of this life', () => {
    // The boundary decides which way an exact tie falls, and it falls towards
    // "still alive" -- the direction that costs a click rather than a second
    // `claude --resume`.
    expect(precedesBoot(NOW - HOUR_MS, NOW, HOUR_SECONDS)).toBe(false);
  });

  it('treats everything as this life on a machine that just booted', () => {
    expect(precedesBoot(NOW - 1, NOW, 0)).toBe(true);
    expect(precedesBoot(NOW, NOW, 0)).toBe(false);
  });
});
