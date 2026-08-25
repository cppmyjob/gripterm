/**
 * The judging half of the eyes: a function from a recording to a verdict, which
 * has never started an editor and never will.
 *
 * The split is the stand's (`tests/stand/judge.ts`) and it is here for the same
 * reason: an eyes that answered RED to every sighting would pass a run of itself
 * exactly as convincingly as a working one, and the only cheap way to tell those
 * two apart is to hand a judge a picture somebody wrote by hand. That is
 * `judge.test.ts`, and it takes a second.
 *
 * Everything this file knows about how a workbench is built is in `drawn()`, and
 * everything it knows about what may be called a defect is in `answer()`. Both
 * are four lines long on purpose.
 */

import type { Answer, Drawn, Finding, Recording, Sighting, Verdict } from './sighting';

/**
 * Whether a person would see it.
 *
 * Two conditions and not one, because a workbench hides a control in two
 * unrelated ways and only one of them shows up in each test. A toolbar under
 * `display: none` -- which is how VS Code keeps a pane's title actions out of
 * the way until the pane is hovered -- gives its children a zero box AND calls
 * them invisible. A pane that is merely collapsed leaves `checkVisibility()`
 * saying true over a box of nothing. Neither is on anybody's screen.
 */
function drawn(what: Drawn): boolean {
  return what.visible && what.box.w > 0 && what.box.h > 0;
}

/** A control, named the way a person would point at it. */
function name(what: Drawn): string {
  return `${what.label}${what.codicon === '' ? '' : ` (${what.codicon})`}`;
}

/**
 * One sighting, answered.
 *
 * The order of the three questions IS the rule, and reordering it is how this
 * stops being worth running:
 *
 *   1. does the sighting name an anchor at all -- a look with nothing of the
 *      editor's own in it cannot tell "we did not draw" from "we did not see";
 *   2. was any anchor drawn -- if not, the eyes did not get a look at that part
 *      of the window and there is no evidence about us either way;
 *   3. only THEN, is ours drawn, and does it look like what the product believes.
 *
 * Steps 1 and 2 produce REFUSED, which is never a defect of the product's. Step
 * 3 is the only door to RED, and by the time it is reached the editor has proved
 * -- with its own control, in the same bar, in the same run -- that the place
 * was there to be looked at.
 */
function answer(one: Sighting): Finding {
  const said = (verdict: Answer, says: string): Finding =>
    ({ point: one.point, scenario: one.scenario, answer: verdict, says });

  if (one.anchors.length === 0) {
    return said(
      'refused',
      `${one.what}: this sighting names no anchor -- no control of the editor's own to prove the eyes ` +
        'got a look at that bar -- so nothing here can tell a button we never drew from a window we never saw.'
    );
  }

  const anchorsDrawn = one.anchors.filter(drawn);
  if (anchorsDrawn.length === 0) {
    return said(
      'refused',
      `${one.what}: the eyes did not get a look at it. Not one of the ${String(one.anchors.length)} control(s) ` +
        `of the editor's own there was drawn either (${one.anchors.map(name).join(', ')}), so whatever is or is ` +
        'not true of our button, this run is not evidence of it.'
    );
  }

  const anchorsSay = `beside ${anchorsDrawn.map(name).join(', ')}, which the editor drew`;

  const ours = one.ours;
  if (ours === null || !drawn(ours)) {
    return said(
      'red',
      `${one.what}: NOT DRAWN, ${anchorsSay}. ` +
        (ours === null
          ? 'Nothing of ours is in that bar at all.'
          : `Ours is in the DOM as ${name(ours)} and has no place on the screen: ` +
            `${String(ours.box.w)}x${String(ours.box.h)} at ${String(ours.box.x)},${String(ours.box.y)}` +
            `, visible=${String(ours.visible)}.`)
    );
  }

  const wanted = one.wanted;
  if (wanted !== null) {
    const wrong: string[] = [];
    if (wanted.codicon !== null && !ours.codicon.split(' ').includes(wanted.codicon)) {
      wrong.push(`it draws ${ours.codicon === '' ? 'no icon' : ours.codicon} where ${wanted.codicon} was due`);
    }
    if (wanted.color !== null && ours.color !== wanted.color) {
      wrong.push(`it is coloured ${ours.color ?? 'nothing at all'} where ${wanted.color} was due`);
    }
    if (wrong.length > 0) {
      return said(
        'red',
        `${one.what}: drawn, and drawn WRONG -- ${wrong.join('; ')}. ` +
          `The product believes ${wanted.because}, so the picture and the record disagree.`
      );
    }
    return said(
      'green',
      `${one.what}: drawn as ${name(ours)} in ${ours.color ?? 'no colour of its own'}, ` +
        `which is what the product believes (${wanted.because}).`
    );
  }

  return said('green', `${one.what}: drawn at ${String(ours.box.w)}x${String(ours.box.h)}, ${anchorsSay}.`);
}

/**
 * The verdict of one run.
 *
 * A recording with no sighting in it is REFUSED and never green. It is what a
 * run that died before it looked leaves behind, and an empty list read as "no
 * defects" is the one way this whole apparatus could report success for having
 * done nothing (I.1).
 */
export function judge(recording: Recording): Verdict {
  const findings = recording.sightings.length === 0
    ? [{
      point: 0,
      scenario: '-',
      answer: 'refused' as const,
      says:
        'this run wrote down no sighting at all. It died before it looked, or it looked at nothing; ' +
        'either way an empty list is not a clean bill of health.',
    }]
    : recording.sightings.map(answer);

  const count = (which: Answer): number => findings.filter((one) => one.answer === which).length;

  return {
    build: recording.build,
    findings,
    green: count('green'),
    red: count('red'),
    refused: count('refused'),
  };
}
