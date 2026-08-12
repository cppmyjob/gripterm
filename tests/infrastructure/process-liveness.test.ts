import {
  isProcessThere,
  pidsEstablishedGone,
  sendSignalZero,
} from '../../packages/core/src/infrastructure/process-liveness';
import type { SignalProbe } from '../../packages/core/src/infrastructure/process-liveness';

const SOME_PID = 4242;
const OTHER_PID = 4243;

function refusing(code: string): SignalProbe {
  return () => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  };
}

const answering: SignalProbe = () => {
  // A process that is there says nothing at all.
};

describe('reading a signal-zero probe', () => {
  it('reads no exception as a process that is there', () => {
    expect(isProcessThere(SOME_PID, answering)).toBe(true);
  });

  it('reads ESRCH as the one refusal that means it is gone', () => {
    expect(isProcessThere(SOME_PID, refusing('ESRCH'))).toBe(false);
  });

  it('reads EPERM as alive, because that is what it means', () => {
    // The measured table (§4.8): a process of another user or another privilege
    // level refuses the signal and is running. `catch { return false }` would
    // call an elevated window dead and hand its terminals away.
    expect(isProcessThere(SOME_PID, refusing('EPERM'))).toBe(true);
  });

  it('reads a refusal with no code as alive', () => {
    expect(
      isProcessThere(SOME_PID, () => {
        throw new Error('something else entirely');
      })
    ).toBe(true);
  });

  it('answers "there" for a pid no signal can be sent to, without asking', () => {
    // `process.kill(0, 0)` signals the caller's own process group and never
    // throws, and a negative pid gives ESRCH -- two opposite wrong answers out
    // of one bad number. Both are refused here, in the direction that keeps a
    // terminal out of the restore plan.
    let asked = 0;
    const counting: SignalProbe = () => {
      asked += 1;
    };

    expect(isProcessThere(0, counting)).toBe(true);
    expect(isProcessThere(-1, counting)).toBe(true);
    expect(isProcessThere(1.5, counting)).toBe(true);
    expect(isProcessThere(Number.NaN, counting)).toBe(true);
    expect(asked).toBe(0);
  });

  it('finds this very process alive through the real probe', () => {
    expect(isProcessThere(process.pid, sendSignalZero)).toBe(true);
  });
});

describe('collecting the pids established to be gone', () => {
  it('keeps only the ones the probe refused with ESRCH', () => {
    const gone = pidsEstablishedGone(
      [SOME_PID, OTHER_PID],
      (pid) => {
        if (pid === SOME_PID) {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        }
      }
    );

    expect([...gone]).toStrictEqual([SOME_PID]);
  });

  it('leaves out what it could not establish, rather than assuming it', () => {
    // Absence from this set is what refuses a restore, so everything unsettled
    // has to be absent: an unaskable pid, and a refusal that was not ESRCH.
    const gone = pidsEstablishedGone([0, SOME_PID], refusing('EPERM'));

    expect(gone.size).toBe(0);
  });

  it('answers an empty set for an empty question', () => {
    expect(pidsEstablishedGone([], answering).size).toBe(0);
  });
});
