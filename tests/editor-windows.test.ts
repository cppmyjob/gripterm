import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * `tools/editor-windows.js`: what the runners that open a real editor are
 * allowed to ask the operating system, and how often.
 *
 * **The defect this exists for, measured 2026-08-26.** A full gate on `78f3eb0`
 * went red at the `stand` stage, and the stand died in its fourth sitting
 * WITHOUT A VERDICT. The death was an uncaught `execFileSync` failure with
 * `status: 3221225794` -- `0xC0000142`, `STATUS_DLL_INIT_FAILED` -- and empty
 * `stdout` and `stderr`. That status is not the script failing and not
 * PowerShell failing: it is Windows declining to create the process at all,
 * which is why neither stream has a character in it. Re-running the same commit
 * was green, so the failure is a function of what else the machine is holding
 * open rather than of the code.
 *
 * Two things follow, and both are checked here.
 *
 *   * **A wait must not start a process per poll.** Asking whether a pid is
 *     still alive is `process.kill(pid, 0)`, which starts nothing; enumerating
 *     windows is a whole `powershell.exe`, and the stand's close-wait did the
 *     second, once every 500 ms, with no bound but its own deadline.
 *   * **A refusal to create a process must be said in words.** A stack ending in
 *     `at powershell (tests/stand/run.mjs:144:10)` tells a reader nothing about
 *     the machine being out of a session resource, and it is the whole reason
 *     the run has no verdict.
 *
 * **What the count actually was, so that nobody re-derives it from the shape of
 * the code.** MEASURED 2026-08-26 over a whole run: TWENTY launches, five per
 * sitting -- and only ONE of the five was a poll. The close-wait looks like the
 * expensive one and is not: a single enumeration takes 750 to 1462 ms on this
 * machine, which is longer than a window takes to go, so the loop answered on
 * its first look every time. The four that remain are the edges of a sitting,
 * where the question genuinely is about a WINDOW. That is why the retry below
 * exists: sixteen chances to be refused are not meaningfully safer than twenty.
 *
 * Loaded through `createRequire` rather than imported: `tools/editor-windows.js`
 * is CommonJS for the reason written at the head of `tools/fork-build.js` --
 * three module systems read the tools, and nothing builds them -- and a `.d.ts`
 * beside it would be a TypeScript file outside `tsconfig.eslint.json`, which is
 * a lint failure rather than a type. So the shape is declared here, at the one
 * place that consumes it from TypeScript.
 */

/** What `execFileSync` throws when the command it was given did not end well. */
interface Refusal extends Error {
  status?: number | null;
  stdout?: string;
  stderr?: string;
}

/** The seam `powershell` is given so that a test can produce an outcome no machine will produce on demand. */
type Runner = (file: string, args: readonly string[], options: object) => string;

/** The other seam, so that a test does not have to spend the seconds a refused run waits. */
type Pause = (ms: number) => void;

/** The seam `isRunning` is given, the same shape as the product's own `SignalProbe`. */
type Probe = (pid: number) => void;

type Asker = (pids: readonly number[]) => readonly number[];

interface WaitOptions {
  readonly withinMs: number;
  readonly pollMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly still?: Asker;
  readonly also?: Asker | null;
}

interface Gone {
  readonly pid: number;
  readonly afterMs: number | null;
  readonly alsoAfterMs: number | null;
}

interface Waited {
  readonly polls: number;
  readonly gone: readonly Gone[];
}

const load = createRequire(__filename);
const {
  isRunning,
  lost,
  opened,
  powershell,
  powershellRuns,
  runningAmong,
  waitUntilGone,
} = load(join(__dirname, '..', 'tools', 'editor-windows.js')) as {
  isRunning: (pid: number, probe?: Probe) => boolean;
  lost: (before: readonly number[], survivors: readonly number[]) => readonly number[];
  opened: (before: readonly number[], now: readonly number[]) => readonly number[];
  powershell: (script: string, run?: Runner, pause?: Pause) => string;
  powershellRuns: () => number;
  runningAmong: (pids: readonly number[]) => readonly number[];
  waitUntilGone: (pids: readonly number[], options: WaitOptions) => Promise<Waited>;
};

/** A runner that fails exactly the way the gate of 2026-08-26 measured it failing. */
const windowsRefusedToStart: Runner = () => {
  throw Object.assign(
    new Error(
      'Command failed: powershell -NoProfile -NonInteractive -Command @(Get-Process | Where-Object {...})'
    ),
    { status: 3_221_225_794, signal: null, stdout: '', stderr: '' }
  );
};

/** A clock that moves only when it is read, so a wait can be made to poll a known number of times. */
function tickingBy(step: number): () => number {
  let reads = 0;
  return () => {
    reads += 1;
    return reads * step;
  };
}

const immediately = async (): Promise<void> => undefined;

/**
 * The pause between two attempts, made free.
 *
 * Passed by every test that provokes a refusal, and not an ornament: the real
 * pause is two whole seconds, twice per refusal, and leaving it in put FORTY
 * SECONDS of `Atomics.wait` into a suite that does no work -- measured
 * 2026-08-26 at 41.6 s for this file alone, against 42.6 s for all 138 of them.
 */
const atOnce: Pause = () => undefined;

describe('counting what the runners start', () => {
  it('counts one launch per script', () => {
    const before = powershellRuns();

    powershell('irrelevant', () => 'answer');
    powershell('irrelevant', () => 'answer');

    expect(powershellRuns() - before).toBe(2);
  });

  it('counts a launch that failed, because a launch that failed is still a launch', () => {
    // The whole point of the number: the run that died on 2026-08-26 died ON a
    // launch. A counter that only counted the ones that came back would have
    // said the machine was under less load than it was.
    const before = powershellRuns();

    expect(() =>
      powershell('irrelevant', () => {
        throw Object.assign(new Error('Command failed'), { status: 1, stdout: '', stderr: 'no' });
      })
    ).toThrow();

    expect(powershellRuns() - before).toBe(1);
  });
});

describe('a refusal to create the process', () => {
  it('is said in words rather than left as a stack', () => {
    expect(() => powershell('anything', windowsRefusedToStart, atOnce)).toThrow(
      /Windows refused to create the process/u
    );
  });

  it('names the status in both the number Node reports and the code Windows means by it', () => {
    let said = '';
    try {
      powershell('anything', windowsRefusedToStart, atOnce);
    } catch (refused: unknown) {
      said = (refused as Error).message;
    }

    expect(said).toContain('3221225794');
    expect(said).toContain('0xC0000142');
    expect(said).toContain('STATUS_DLL_INIT_FAILED');
  });

  it('says why both streams are empty, which is the part a reader misreads', () => {
    let said = '';
    try {
      powershell('anything', windowsRefusedToStart, atOnce);
    } catch (refused: unknown) {
      said = (refused as Error).message;
    }

    expect(said).toMatch(/never started|nothing of it ever ran/u);
  });

  it('says that the run measured nothing from there on', () => {
    let said = '';
    try {
      powershell('anything', windowsRefusedToStart, atOnce);
    } catch (refused: unknown) {
      said = (refused as Error).message;
    }

    expect(said).toContain('no verdict');
  });

  it('keeps the original failure as the cause, so nothing is thrown away', () => {
    let cause: unknown;
    try {
      powershell('anything', windowsRefusedToStart, atOnce);
    } catch (refused: unknown) {
      cause = (refused as { cause?: unknown }).cause;
    }

    expect((cause as Refusal | undefined)?.status).toBe(3_221_225_794);
  });

  it('names an NTSTATUS it has no word for, rather than falling silent about it', () => {
    const crashed = (): string => {
      throw Object.assign(new Error('Command failed'), {
        status: 3_221_225_477,
        stdout: '',
        stderr: '',
      });
    };
    let said = '';
    try {
      powershell('anything', crashed, atOnce);
    } catch (refused: unknown) {
      said = (refused as Error).message;
    }

    expect(said).toContain('0xC0000005');
    expect(said).toContain('Windows refused to create the process');
  });

  it.each(['EMFILE', 'ENOMEM', 'EAGAIN', 'ENFILE'])(
    'says the same thing when Node itself could not start it: %s',
    (code) => {
      // The other half of the same defect. `0xC0000142` is Windows declining;
      // these four are the process never being attempted, for the same reason --
      // the machine is out of something. A reader must not have to know which
      // layer said no in order to read "too much is open".
      const outOf = (): string => {
        throw Object.assign(new Error('spawnSync powershell'), { code, status: null });
      };
      let said = '';
      try {
        powershell('anything', outOf, atOnce);
      } catch (refused: unknown) {
        said = (refused as Error).message;
      }

      expect(said).toContain(code);
      expect(said).toContain('no verdict');
    }
  );

  it('leaves an ordinary failure exactly as it was', () => {
    // A script that ran and exited non-zero is the script's business, and
    // renaming it would hide a real error behind a sentence about desktop heap.
    const ordinary = (): string => {
      throw Object.assign(new Error('Command failed: powershell ...'), {
        status: 1,
        stdout: '',
        stderr: 'Get-Process : Cannot find a process with the name "nope".',
      });
    };

    expect(() => powershell('anything', ordinary)).toThrow('Command failed: powershell ...');
  });

  it('leaves a failure with output alone even when its status is an NTSTATUS', () => {
    // Output means the process ran. Whatever killed it afterwards, it is not the
    // machine declining to create it, and the sentence would be a lie.
    const spoke = (): string => {
      throw Object.assign(new Error('Command failed: powershell ...'), {
        status: 3_221_225_794,
        stdout: 'four thousand and one\n',
        stderr: '',
      });
    };

    expect(() => powershell('anything', spoke)).toThrow('Command failed: powershell ...');
  });
});

describe('trying again after a refusal to create the process', () => {
  /*
   * MEASURED 2026-08-26, and it is why this exists at all. A whole run of the
   * stand starts TWENTY `powershell.exe` over four minutes -- four per sitting
   * at the edges plus one poll -- and the gate that died was refused one of
   * those twenty. Twenty launches spread over four minutes is not what exhausts
   * a session, so making it sixteen prevents nothing: what the run needs is to
   * survive being told no once.
   *
   * Conditions it holds under (II.5): the shortage is TRANSIENT -- windows are
   * closing and handles are coming back -- and one whole run asks for a process
   * of the order of twenty times, so a few seconds of waiting is cheap against a
   * seven-minute gate that ends with no verdict. Condition for taking it away:
   * a stand that no longer starts a process to find out what it can find out
   * without one. `tests/stand/run.mjs` is down to four launches a sitting, all
   * four of them questions about WINDOWS -- and the day the runner knows its own
   * window by the pid it spawned, three of the four go, and this goes with them.
   */

  /** A runner that is refused `times` times and then answers. */
  function refusedTimes(times: number): { run: Runner, tries: () => number } {
    let tries = 0;
    return {
      run: (): string => {
        tries += 1;
        if (tries <= times) {
          throw Object.assign(new Error('Command failed'), {
            status: 3_221_225_794,
            stdout: '',
            stderr: '',
          });
        }
        return '  the answer  ';
      },
      tries: () => tries,
    };
  }

  it('comes back with the answer when the second attempt is let through', () => {
    const refused = refusedTimes(1);

    expect(powershell('anything', refused.run, atOnce)).toBe('the answer');
    expect(refused.tries()).toBe(2);
  });

  it('waits before trying again, rather than asking the same machine in the same instant', () => {
    const refused = refusedTimes(1);
    const waited: number[] = [];

    powershell('anything', refused.run, (ms) => {
      waited.push(ms);
    });

    expect(waited).toStrictEqual([2000]);
  });

  it('gives up after the attempts it promised, and says how many there were', () => {
    const refused = refusedTimes(99);
    let said = '';
    try {
      powershell('anything', refused.run, atOnce);
    } catch (gaveUp: unknown) {
      said = (gaveUp as Error).message;
    }

    expect(refused.tries()).toBe(3);
    expect(said).toContain('3 times');
  });

  it('counts every attempt, because every attempt asked the machine for a process', () => {
    const before = powershellRuns();
    const refused = refusedTimes(99);

    expect(() => powershell('anything', refused.run, atOnce)).toThrow();

    expect(powershellRuns() - before).toBe(3);
  });

  it('does not try again after a failure that is the script`s own', () => {
    let tries = 0;
    const ordinary: Runner = () => {
      tries += 1;
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stdout: '',
        stderr: 'Get-Process : no such thing',
      });
    };

    expect(() => powershell('anything', ordinary, atOnce)).toThrow('Command failed');
    expect(tries).toBe(1);
  });
});

describe('asking whether a pid is still running', () => {
  it('says yes about this very process', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  it('says no about a process that has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000);'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const pid = child.pid ?? 0;
    expect(isRunning(pid)).toBe(true);

    child.kill();
    await once(child, 'exit');

    expect(isRunning(pid)).toBe(false);
  });

  it('starts no process to find out', () => {
    const before = powershellRuns();

    for (let asked = 0; asked < 200; asked += 1) {
      isRunning(process.pid);
    }

    expect(powershellRuns() - before).toBe(0);
  });

  it('reads EPERM as alive, because that is what it means', () => {
    // A window started by an administrator refuses the signal and is running.
    // `catch { return false }` would call it dead and let the stand walk on.
    expect(
      isRunning(4242, () => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      })
    ).toBe(true);
  });

  it('reads ESRCH as the one refusal that means gone', () => {
    expect(
      isRunning(4242, () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      })
    ).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('answers "still there" for %p without asking', (notAPid) => {
    // `process.kill(0, 0)` signals the CALLER's process group and never throws;
    // a negative pid gives ESRCH. Two opposite wrong answers out of one bad
    // number, and the caller reads "still there" as "keep waiting", which is the
    // direction that never closes somebody else's window.
    let asked = 0;

    expect(
      isRunning(notAPid, () => {
        asked += 1;
      })
    ).toBe(true);
    expect(asked).toBe(0);
  });

  it('keeps only the pids that are still running', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000);'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const pid = child.pid ?? 0;
    child.kill();
    await once(child, 'exit');

    expect(runningAmong([process.pid, pid])).toStrictEqual([process.pid]);
  });
});

describe('waiting for windows to be gone', () => {
  it('starts no process at all, however it ends', async () => {
    // THE measurement of this whole file, and it deliberately says nothing about
    // how the wait ENDS: the count has to be zero whether the wait gave up or
    // came back happy, and the two tests below are the ones about the answer.
    const before = powershellRuns();

    await waitUntilGone([process.pid], {
      withinMs: 10_000,
      pollMs: 500,
      sleep: immediately,
      now: tickingBy(500),
    }).catch(() => undefined);

    expect(powershellRuns() - before).toBe(0);
  });

  it('polls until the deadline rather than giving up on the first look', async () => {
    let slept = 0;

    await expect(
      waitUntilGone([process.pid], {
        withinMs: 10_000,
        pollMs: 500,
        sleep: async () => {
          slept += 1;
          return undefined;
        },
        now: tickingBy(500),
      })
    ).rejects.toThrow(/gave up/u);

    expect(slept).toBeGreaterThanOrEqual(10);
  });

  it('says which pids it was waiting for when it gives up', async () => {
    await expect(
      waitUntilGone([process.pid], {
        withinMs: 1000,
        pollMs: 500,
        sleep: immediately,
        now: tickingBy(500),
      })
    ).rejects.toThrow(String(process.pid));
  });

  it('comes back with how long each pid took to go', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000);'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const pid = child.pid ?? 0;
    child.kill();
    await once(child, 'exit');

    const waited = await waitUntilGone([pid], { withinMs: 10_000, pollMs: 10 });

    expect(waited.gone.map((one) => one.pid)).toStrictEqual([pid]);
    expect(waited.polls).toBeGreaterThan(0);
  });

  it('is content at once when there is nothing to wait for', async () => {
    const waited = await waitUntilGone([], { withinMs: 1000, pollMs: 500 });

    expect(waited.gone).toStrictEqual([]);
  });
});

describe('watching a second question while waiting on the first', () => {
  /*
   * The seam that MEASURES the one thing this change had to be decided by: a
   * window disappearing and the process behind it exiting are two events, and
   * moving the wait from the first to the second is only safe if the gap between
   * them is small. `still` decides when the wait is over; `also` is written down
   * and decides nothing.
   */

  /** An asker that reports its pids gone from the `n`th poll onwards. */
  function goneFromPoll(n: number): Asker {
    let polls = 0;
    return (pids) => {
      polls += 1;
      return polls >= n ? [] : pids;
    };
  }

  it('writes down when the second question changed its answer', async () => {
    const waited = await waitUntilGone([4242], {
      withinMs: 10_000,
      pollMs: 500,
      sleep: immediately,
      now: tickingBy(500),
      still: goneFromPoll(2),
      also: goneFromPoll(4),
    });

    expect(waited.gone).toHaveLength(1);
    expect(waited.gone[0]?.afterMs).not.toBeNull();
    expect(waited.gone[0]?.alsoAfterMs).toBeGreaterThan(waited.gone[0]?.afterMs ?? 0);
  });

  it('never fails a wait for the sake of the question that decides nothing', async () => {
    // A watcher that never settles must cost the run a deadline and not a death:
    // the answer the wait was for is already in.
    const waited = await waitUntilGone([4242], {
      withinMs: 2000,
      pollMs: 500,
      sleep: immediately,
      now: tickingBy(500),
      still: goneFromPoll(1),
      also: (pids) => pids,
    });

    expect(waited.gone[0]?.alsoAfterMs).toBeNull();
  });

  it('asks the second question not at all when nobody asked for it', async () => {
    let asked = 0;

    await waitUntilGone([4242], {
      withinMs: 10_000,
      pollMs: 500,
      sleep: immediately,
      now: tickingBy(500),
      still: goneFromPoll(1),
      also: null,
    });
    await waitUntilGone([4242], {
      withinMs: 10_000,
      pollMs: 500,
      sleep: immediately,
      now: tickingBy(500),
      still: () => {
        asked += 1;
        return [];
      },
    });

    expect(asked).toBe(1);
  });
});

describe('telling our own windows from the one somebody is working in', () => {
  it('calls ours only what was not there before we started', () => {
    expect(opened([11, 22], [11, 22, 33])).toStrictEqual([33]);
  });

  it('calls nothing ours when nothing appeared', () => {
    // The day this returns a pid that was already open, the stand closes the
    // window the owner of this machine is sitting in.
    expect(opened([11, 22], [22, 11])).toStrictEqual([]);
  });

  it('still calls ours ours when one of the old ones has gone in the meantime', () => {
    expect(opened([11, 22], [11, 33])).toStrictEqual([33]);
  });

  it('names the windows that were there before and are not there now', () => {
    expect(lost([11, 22], [22])).toStrictEqual([11]);
  });

  it('names none when every window that was there survived', () => {
    expect(lost([11, 22], [11, 22, 33])).toStrictEqual([]);
  });
});
