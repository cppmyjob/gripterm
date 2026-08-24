import { announceRefusal, underTheRoom } from './integration/room-this-runs-in';
import type { RoomVerdict } from './integration/room-this-runs-in';

/**
 * What a test does about the room it runs in, when the room can change under it.
 *
 * **What this generalises, and why it had to be generalised.** `underTheClipboard`
 * (17063e3) held one condition: the clipboard. It was right about the mechanism
 * and wrong about the census -- on 2026-08-24 a full `own` run went ELEVEN red
 * and the clipboard was not one of the eleven reasons. The clipboard detector
 * was asked, said "ours", and was telling the truth; what the eleven had in
 * common was the KEYBOARD of the window, which nothing was asking about at all.
 * So the shape stays and the number of conditions stops being one.
 *
 * **Asked before and asked again**, because a gate meant to run unattended runs
 * in a room that changes: somebody's screen lock fires four minutes in, somebody
 * comes back to the machine and clicks on their browser. A one-shot check at the
 * start is what failed. The second ask happens only on the way out of a failure,
 * so a passing run pays nothing for it.
 *
 * **The property that outranks the rest**: a room that was there before and
 * there after cannot turn a failure into a refusal. That is what stops this from
 * being a way to switch a gate off.
 */

const THERE: RoomVerdict = { ours: true, refusal: '' };

function gone(what: string): RoomVerdict {
  return { ours: false, refusal: `the room has no ${what}` };
}

/** Stands in for Mocha's own `this.skip()`, which does not return either. */
function refusing(said: string[]): (verdict: RoomVerdict) => never {
  return (verdict) => {
    said.push(verdict.refusal);
    throw new Error(`REFUSED: ${verdict.refusal}`);
  };
}

/** An answer that changes: what a room does while a suite is running in it. */
function answering(...answers: RoomVerdict[]): () => Promise<RoomVerdict> {
  const left = [...answers];
  const last = answers[answers.length - 1] ?? THERE;
  return async () => await Promise.resolve(left.shift() ?? last);
}

describe('a test that needs the room, when the room has more than one thing in it', () => {
  it('runs the test when every condition is there', async () => {
    const said: string[] = [];
    let ran = 0;

    await underTheRoom(
      [answering(THERE), answering(THERE)],
      refusing(said),
      async () => { ran += 1; await Promise.resolve(); }
    );

    expect(ran).toBe(1);
    expect(said).toEqual([]);
  });

  it('refuses before the test runs when any condition is already gone', async () => {
    const said: string[] = [];
    let ran = 0;

    await expect(underTheRoom(
      [answering(THERE), answering(gone('clipboard'))],
      refusing(said),
      async () => { ran += 1; await Promise.resolve(); }
    )).rejects.toThrow('REFUSED: the room has no clipboard');

    // Not run at all, which is the point: each of these tests spends thirty
    // seconds waiting for something that cannot arrive.
    expect(ran).toBe(0);
  });

  it('names the FIRST condition that is missing and stops asking there', async () => {
    // One sentence out of a refused run, and it is about the first thing that is
    // wrong. Asking the rest could only add a second answer to the same
    // question, and the cheapest condition is declared first on purpose.
    const said: string[] = [];
    let askedTheSecond = 0;

    await expect(underTheRoom(
      [
        answering(gone('keyboard')),
        async () => { askedTheSecond += 1; return await Promise.resolve(THERE); },
      ],
      refusing(said),
      async () => { await Promise.resolve(); }
    )).rejects.toThrow('REFUSED: the room has no keyboard');

    expect(askedTheSecond).toBe(0);
  });

  it('lets the failure out when the room was there the whole time', async () => {
    // THE property this whole thing has to keep, and the reason it is allowed to
    // exist at all: a room that is there and a build that is broken is RED, and
    // stays red. Everything else here is convenience; this one is the contract.
    const said: string[] = [];

    await expect(underTheRoom(
      [answering(THERE), answering(THERE)],
      refusing(said),
      async () => { await Promise.reject(new Error('the newline never reached the process')); }
    )).rejects.toThrow('the newline never reached the process');

    expect(said).toEqual([]);
  });

  it('refuses instead when a condition went away while the test was running', async () => {
    // The unattended case, and the one the eleven reds of 2026-08-24 were: the
    // room is fine when the run starts and something takes the keyboard four
    // minutes in. Nothing about the build changed.
    const said: string[] = [];

    await expect(underTheRoom(
      [answering(THERE, gone('keyboard'))],
      refusing(said),
      async () => { await Promise.reject(new Error('waited 30000 ms for the keyboard')); }
    )).rejects.toThrow('REFUSED: the room has no keyboard');

    expect(said).toEqual(['the room has no keyboard']);
  });

  it('asks every condition again after a failure, not only the one it asked first', async () => {
    // A room that lost its SECOND condition mid-run would otherwise come out red
    // with a sentence about the build.
    const said: string[] = [];

    await expect(underTheRoom(
      [answering(THERE), answering(THERE, gone('clipboard'))],
      refusing(said),
      async () => { await Promise.reject(new Error('the paste never arrived')); }
    )).rejects.toThrow('REFUSED: the room has no clipboard');

    expect(said).toEqual(['the room has no clipboard']);
  });

  it('runs the body once, and only when nothing has refused', async () => {
    let ran = 0;

    await underTheRoom(
      [answering(THERE)],
      refusing([]),
      async () => { ran += 1; await Promise.resolve(); }
    );

    expect(ran).toBe(1);
  });
});

/*
 * Every sentence below is its own, and that is not decoration: what is being
 * tested is that a sentence is said ONCE for the life of the run, so two tests
 * sharing one would be one test measuring the other's leftovers.
 */
describe('saying a refusal out loud, which is the whole difference from a skip', () => {
  it('says it, because a refusal nobody can see is a skip', () => {
    const heard: string[] = [];

    announceRefusal('this run has nowhere to say anything', (line) => heard.push(line));

    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('this run has nowhere to say anything');
    // Findable in a log that is mostly the editor talking to itself.
    expect(heard[0]).toContain('GRIPTERM REFUSES');
  });

  it('says one refusal once, however many tests it refuses', () => {
    // Five identical paragraphs are five chances to stop reading.
    const heard: string[] = [];

    for (let refused = 0; refused < 5; refused += 1) {
      announceRefusal('this run keeps meeting the same wall', (line) => heard.push(line));
    }

    expect(heard).toHaveLength(1);
  });

  it('says a DIFFERENT refusal as well, because it is a different condition', () => {
    // A run can meet both: something took the keyboard and something else took
    // the clipboard. Suppressing the second would leave half the room unnamed.
    const heard: string[] = [];

    announceRefusal('this run met a wall of one kind', (line) => heard.push(line));
    announceRefusal('this run met a wall of another kind', (line) => heard.push(line));

    expect(heard).toHaveLength(2);
  });
});
