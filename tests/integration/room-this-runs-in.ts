/**
 * What a test does about the room it runs in, and what it must never do with it.
 *
 * **Where this came from.** `underTheClipboard` (17063e3) was this, with one
 * condition in it. It was right about the mechanism and wrong about the census:
 * on 2026-08-24 a full `own` run went ELEVEN red with the clipboard detector
 * saying "the clipboard is ours" -- and telling the truth, because the same
 * suite run again on the same locked machine passed all eleven in 22 seconds.
 * What the eleven had in common was not the clipboard. It was the KEYBOARD of
 * the window, which nothing was asking about. So the shape stays and the number
 * of conditions stops being one.
 *
 * **Asked before and asked again.** These runs are meant to go unattended while
 * somebody uses the machine for something else, so the room can change under
 * them: a screen lock timer fires four minutes in, a person comes back and
 * clicks on their browser. A one-shot check at the start is exactly what failed.
 * The second ask happens only on the way out of a failure, so a passing run pays
 * nothing for it.
 *
 * **The property that outranks every convenience here**: a room that was there
 * before the test and there after it cannot turn a failure into a refusal.
 * Without that, this is a way to switch a gate off; with it, red still means the
 * product. Held by `tests/room-this-runs-in.test.ts`, which is where to look
 * before changing anything below.
 */

/** What a condition of the room answers when it is asked whether it is there. */
export interface RoomVerdict {
  /** Whether the thing the suite needs is really there. */
  readonly ours: boolean;
  /** What to say when it is not. Empty when it is. */
  readonly refusal: string;
}

/**
 * One condition of the room, asked by USING the thing rather than by deducing it
 * from a lock state, a foreground window or a session id. Every one of those
 * proxies is wrong somewhere, and two of them are wrong on this machine.
 */
export type AskTheRoom = () => Promise<RoomVerdict>;

/**
 * Runs a test that cannot work unless the room gives it something, and refuses
 * instead of failing when the room does not.
 *
 * The conditions are asked in the order they are declared and the first one
 * missing is the one named: they answer different questions, and a run that
 * refused with two paragraphs would be a run whose reader has to decide which of
 * them to act on.
 *
 * `refuse` never returns -- Mocha's own `this.skip()` does not either -- so a
 * refusal cannot be mistaken for a pass by anything downstream of it.
 */
export async function underTheRoom(
  asks: readonly AskTheRoom[],
  refuse: (verdict: RoomVerdict) => never,
  body: () => Promise<void>
): Promise<void> {
  const before = await firstMissing(asks);
  if (before !== null) {
    refuse(before);
  }
  try {
    await body();
  } catch (cause: unknown) {
    const after = await firstMissing(asks);
    if (after !== null) {
      refuse(after);
    }
    // Every condition was there before and every one is there now, so whatever
    // went wrong in between is ours to answer for.
    throw cause;
  }
}

/** Every refusal already said, so that saying it again can be declined. */
const alreadySaid = new Set<string>();

/**
 * Says a refusal out loud, once for the life of the run.
 *
 * Out loud is the whole difference between this and a skip: a test that quietly
 * does not run is a test nobody will miss. Once, because five identical
 * paragraphs are five chances to stop reading -- but once PER SENTENCE, because
 * a run can meet two different conditions and suppressing the second would leave
 * half the room unnamed.
 */
export function announceRefusal(
  refusal: string,
  say: (line: string) => void = console.log
): void {
  if (alreadySaid.has(refusal)) {
    return;
  }
  alreadySaid.add(refusal);
  say(`\n  ===> GRIPTERM REFUSES ${refusal}\n`);
}

/** The first condition that is not there, or `null` when the room is whole. */
async function firstMissing(asks: readonly AskTheRoom[]): Promise<RoomVerdict | null> {
  for (const ask of asks) {
    // In order and one at a time, on purpose: the cheapest condition is declared
    // first, and asking the rest could only add a second answer to a question
    // that is already answered.
    const verdict = await ask();
    if (!verdict.ours) {
      return verdict;
    }
  }
  return null;
}
