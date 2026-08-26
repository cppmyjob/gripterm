/**
 * What the eyes write down, in words both halves of the stand agree on.
 *
 * **Why there is a file of nothing but shapes.** The eyes are two programs that
 * never meet: `run.mjs` starts an editor, attaches to it over the DevTools
 * protocol and asks the workbench's own DOM what it is drawing; `judge.ts` is a
 * function from what came back to a verdict, and it has never seen an editor.
 * The format below is the only thing they share, so it is written once and
 * imported by both -- and the recording it describes is a FILE, which is what
 * lets the second half be checked in a second by `npx jest` instead of in two
 * minutes by a window opening on somebody's desktop.
 *
 * **The one idea worth reading twice: an ANCHOR.** Every sighting names, beside
 * the control of OURS it is looking for, one or more controls of the EDITOR'S
 * OWN that live in the same bar. Without that a missing button has two possible
 * causes and no way to tell them apart -- the product never drew it, or the eyes
 * never got a look at that part of the window -- and the second dressed as the
 * first is a gate that goes red at the fork's release schedule. Measured
 * 2026-08-25 and this is not hypothetical: in a Cursor started on a fresh
 * profile the whole side bar has no layout at all, and OUR button and the
 * editor's own `Collapse Folders in Explorer` are both absent from it by exactly
 * the same measurement. A judge that read only our half would have called that
 * a defect of ours three times a week.
 *
 * So the rule the judge holds is: no anchor drawn, no verdict -- the sighting is
 * REFUSED and says why. An anchor drawn and ours not is the only thing that is
 * allowed to be RED, and it is then unambiguous.
 */

/** Where something sits on the screen, in the workbench's own pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One control, as the workbench's DOM answered for it.
 *
 * `visible` is the browser's own `checkVisibility()` and `box` is
 * `getBoundingClientRect()`, and BOTH are kept because they fail differently: a
 * control inside a `display: none` toolbar reports invisible AND a zero box,
 * while one in a collapsed pane reports a zero box while calling itself visible.
 * A person sees neither, so the judge demands both.
 */
export interface Drawn {
  /** The `aria-label` or `title` the workbench gave it -- what a screen reader would say. */
  readonly label: string;
  /** Its codicon classes, joined. Empty when it draws no icon. */
  readonly codicon: string;
  readonly box: Box;
  readonly visible: boolean;
  /** The computed CSS colour, when the sighting is about colour. `null` when it is not. */
  readonly color: string | null;
}

/**
 * What our control must LOOK like, when the sighting is about looks rather than
 * presence.
 *
 * It is filled in from what the PRODUCT believes at that moment -- the observer
 * extension reads the state through the API and hands it over -- so a sighting
 * with a `wanted` is asking one question only: does the picture agree with the
 * thing that drew it. That is the whole of "залипло": the record moved on and
 * the icon did not.
 */
export interface Wanted {
  /** A codicon class the control must carry, e.g. `codicon-check`. */
  readonly codicon: string | null;
  /** A computed colour it must have, e.g. `rgb(63, 162, 102)`. */
  readonly color: string | null;
  /**
   * The name it must carry -- for the sightings whose question is WHICH thing
   * is drawn rather than how it looks.
   *
   * S25 is that question and nothing else: the notification says a terminal is
   * waiting, the person clicks it, and what has to be in front afterwards is
   * THAT terminal. A tab of the right colour with the wrong name on it is the
   * complaint, not the answer, and a judge that compared only icons and colours
   * would call it green.
   */
  readonly label?: string;
  /** What the product believed, in words, so a red says what it disagreed with. */
  readonly because: string;
}

/** One look at one place in the workbench. */
export interface Sighting {
  /** Its number in the verdict, stable across runs so a budget can name one. */
  readonly point: number;
  /** The scenario of `docs/experiments/2026-08-23-qa-scenarios.md` this is about. */
  readonly scenario: string;
  /** What was being looked for, in a sentence a person can act on. */
  readonly what: string;
  /** Our control, or `null` when nothing of ours was found in that place. */
  readonly ours: Drawn | null;
  /**
   * Controls of the EDITOR'S OWN in the same bar. Never empty: a sighting with
   * no anchor cannot be judged, and the judge says so rather than guessing.
   */
  readonly anchors: readonly Drawn[];
  /**
   * What those anchors ARE, in words, for the sentence a refusal prints.
   *
   * Not decoration, and it was added after a receipt lied. Measured 2026-08-26
   * in Cursor 3.17.19: an S26 sighting refused with "not one of the 1 control(s)
   * of the EDITOR'S OWN there was drawn either (eyes-project 2)" -- and that
   * control is ours. S13 anchors on the editor's own buttons; S26 anchors on
   * the row, which is the product's belief drawn by the editor's list, and the
   * two are different arguments. Left out where the default is true.
   */
  readonly anchorsAre?: string;
  /** What ours must look like, or `null` when the sighting only asks whether it is there. */
  readonly wanted: Wanted | null;
}

/** The build of the editor that answered, out of its own `product.json`. */
export interface Build {
  readonly editor: string;
  readonly version: string;
  readonly vscodeVersion: string | null;
  readonly commit: string | null;
  readonly built: string | null;
}

/** Everything one run of the eyes saw. */
export interface Recording {
  readonly build: Build | null;
  /** Whether the editor's own first-run overlay was in the way, and was cleared. */
  readonly onboardingOverlaysCleared: number;
  readonly sightings: readonly Sighting[];
}

/** What a sighting came to. */
export type Answer = 'green' | 'red' | 'refused';

/** One line of the verdict. */
export interface Finding {
  readonly point: number;
  readonly scenario: string;
  readonly answer: Answer;
  /** Why, in one sentence, including the numbers it was decided on. */
  readonly says: string;
}

/** The verdict of one run, which is what `tools/gate.mjs` reads. */
export interface Verdict {
  readonly build: Build | null;
  readonly findings: readonly Finding[];
  readonly green: number;
  readonly red: number;
  readonly refused: number;
}
