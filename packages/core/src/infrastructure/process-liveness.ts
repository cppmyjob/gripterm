/** The one `process.kill` outcome that means the process is not there (§4.8). */
const NO_SUCH_PROCESS = 'ESRCH';

/**
 * What ends a process of ours, and why there is only one of them (M3.5).
 *
 * `SIGKILL` and not a `SIGTERM` first, and that is a decision with its reason
 * attached rather than impatience. On Windows the two are the same call --
 * libuv maps every signal a process is sent from Node to `TerminateProcess` --
 * so an escalation would be code that cannot be told apart from this one on the
 * machine it was written on, standing in front of an act nothing takes back. On
 * Unix the courteous signal has already been sent by the time this runs: the
 * pty's own kill sends `SIGHUP` first, and this is the backstop for a process
 * that ignored it. The Unix-only escalation is named in the plan's register
 * rather than written blind.
 */
const KILL_SIGNAL = 'SIGKILL';

/**
 * Sends signal 0 to a process, or throws the way `process.kill` does.
 *
 * A seam, and a narrow one on purpose. The outcome the rule below turns on --
 * `EPERM`, which means the process IS there and belongs to another user or
 * another privilege level -- cannot be produced by a test that does not run a
 * second user's process, and a rule no test can reach is a rule nobody can say
 * still holds.
 */
export type SignalProbe = (pid: number) => void;

/**
 * Ends a process by pid, or throws the way `process.kill` does.
 *
 * The same shape as `SignalProbe` and deliberately a different name: one of them
 * asks a question and the other performs the act nothing takes back, and a
 * parameter that accepts either would let a wiring mistake substitute one for
 * the other in silence.
 */
export type ProcessEnder = (pid: number) => void;

export const sendSignalZero: SignalProbe = (pid) => {
  process.kill(pid, 0);
};

/**
 * Ends a process by pid, or throws the way `process.kill` does.
 *
 * The one place in this build that reaches the platform to end something, and it
 * refuses a number that is not a pid before it gets there. That guard is not
 * ceremony: `process.kill(0, ...)` does not mean "process zero", it signals the
 * CALLER's own process group -- so a stray `0` would be this extension killing
 * the editor that loaded it, and a negative number would signal a whole group of
 * somebody else's. `ObservedState` already refuses to hold anything but a
 * positive integer, which makes this the second lock on the one door that does
 * not open again.
 */
export const sendKillSignal: ProcessEnder = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError(`${String(pid)} is not a pid, so nothing was signalled`);
  }
  process.kill(pid, KILL_SIGNAL);
};

/**
 * Whether a process answers to that pid, by the table measured on this machine
 * (§4.8): no exception means it is there, `ESRCH` means it is not, and **every
 * other refusal -- `EPERM` above all -- means it is there and not ours to
 * signal**. A naive `catch { return false }` would call a window started by an
 * administrator dead while it is running.
 *
 * A pid that cannot be signalled at all is answered `true`, and that is the
 * honest direction rather than a convenience. `process.kill(0, 0)` does not
 * signal a process: it signals the CALLER's process group and never throws, so
 * asking would produce "alive" for anything; a negative pid gives `ESRCH` and
 * would produce "gone", which authorises adoption and, through it, a second
 * `claude --resume` on a live conversation. Both callers read `true` as "do not
 * touch this", so a question that cannot be asked costs a confirmation click.
 */
export function isProcessThere(pid: number, probe: SignalProbe): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    probe(pid);
    return true;
  } catch (cause: unknown) {
    return (cause as { readonly code?: unknown }).code !== NO_SUCH_PROCESS;
  }
}

/**
 * Of the pids asked about, the ones ESTABLISHED to be gone.
 *
 * The set is deliberately the smaller half. Its consumer is the restore planner,
 * where membership is what permits a `claude --resume`, so everything the probe
 * could not settle -- a pid never asked about, a refusal that was not `ESRCH`, a
 * number no signal can be sent to -- stays outside it and keeps its terminal out
 * of the plan. Absence means "not established", never "not running".
 */
export function pidsEstablishedGone(
  pids: Iterable<number>,
  probe: SignalProbe
): ReadonlySet<number> {
  const gone = new Set<number>();
  for (const pid of pids) {
    if (!isProcessThere(pid, probe)) {
      gone.add(pid);
    }
  }
  return gone;
}
