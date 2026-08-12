const MS_PER_SECOND = 1000;

/**
 * Whether a moment recorded on this machine predates its last boot.
 *
 * One comparison, and it deterministically removes the whole cross-boot class of
 * pid reuse -- which on Windows is most of it, because a pid is released the
 * moment its process closes and handed out again aggressively (§4.8, measured).
 * Nothing written by a process that is alive NOW can predate the boot that
 * process started after; so a record whose last sign of life is older than the
 * boot cannot be describing anything still running, whatever its pid says today.
 *
 * Two rules stand on this and they are the same rule, which is why it is here
 * and not in either of them:
 *
 *   * owner liveness (M2.4) -- a heartbeat older than the boot is a dead window,
 *     ahead of the pid probe;
 *   * the restore planner (M2.10) -- an observed state older than the boot is a
 *     session that is not running, ahead of the pid probe.
 *
 * `uptimeSeconds` is `os.uptime()` at the caller. Its behaviour through sleep
 * and Windows Fast Startup is the open question A14, unmeasurable on the machine
 * this was built on (hibernation is off, so Fast Startup cannot be enabled).
 * What was measured there is in favour: `os.uptime()` is `GetTickCount64()/1000`,
 * a biased clock that keeps running through S3 sleep, and the boot moment it
 * implies was 5 s from `Win32_OperatingSystem.LastBootUpTime` over 16 days -- in
 * the safe direction, an EARLIER boot, which makes this return `false` and costs
 * a confirmation click rather than a second `claude --resume`. If A14 ever lands
 * badly, this is the single line to change.
 */
export function precedesBoot(atMs: number, nowMs: number, uptimeSeconds: number): boolean {
  return atMs < nowMs - uptimeSeconds * MS_PER_SECOND;
}
