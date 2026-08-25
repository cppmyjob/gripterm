/**
 * The judging half of the eyes, held to the one property that makes it worth
 * having: a run that could not SEE must never be readable as a run that saw
 * something wrong.
 *
 * Every case below is a recording built by hand. No editor starts here, which is
 * the point: `pnpm run test:eyes` needs two minutes and a desktop to tell a red
 * eyes from a green one, and this file does it in a second. Without it, an eyes
 * that answered RED to everything would pass its own run exactly as well as a
 * working one.
 */

import { judge } from './judge';
import type { Drawn, Recording, Sighting, Wanted } from './sighting';

const SEEN: Drawn = {
  label: 'Gripterm: Maximise the Terminals, or Put Them Back',
  codicon: 'codicon-screen-full',
  box: { x: 400, y: 40, w: 22, h: 22 },
  visible: true,
  color: null,
};

const THEIRS: Drawn = {
  label: 'Split Editor Right',
  codicon: 'codicon-split-horizontal',
  box: { x: 424, y: 40, w: 22, h: 22 },
  visible: true,
  color: null,
};

/** In the DOM and with no layout at all: what a control in a collapsed pane looks like. */
const NO_BOX: Drawn = { ...SEEN, box: { x: 0, y: 0, w: 0, h: 0 }, visible: false };

/** A box, but the browser calls it invisible: a control under `visibility: hidden`. */
const INVISIBLE: Drawn = { ...SEEN, visible: false };

function recordingOf(...sightings: readonly Sighting[]): Recording {
  return { build: null, onboardingOverlaysCleared: 0, sightings };
}

function sighting(over: Partial<Sighting> = {}): Sighting {
  return {
    point: 1,
    scenario: 'S13',
    what: 'the maximise button in the terminal group',
    ours: SEEN,
    anchors: [THEIRS],
    wanted: null,
    ...over,
  };
}

describe('the eyes, judging what they saw', () => {
  it('is green when ours is drawn beside a control of the editor own', () => {
    const verdict = judge(recordingOf(sighting()));

    expect(verdict.findings[0]?.answer).toBe('green');
    expect(verdict.green).toBe(1);
    expect(verdict.red).toBe(0);
    expect(verdict.refused).toBe(0);
  });

  it('is RED when the editor drew its own control there and not ours', () => {
    const verdict = judge(recordingOf(sighting({ ours: null })));

    expect(verdict.findings[0]?.answer).toBe('red');
    // The anchor is named in the sentence, because a red that does not say what
    // it was measured against is a red somebody will argue with.
    expect(verdict.findings[0]?.says).toContain('Split Editor Right');
  });

  it('REFUSES rather than reddens when no control of the editor own was drawn either', () => {
    const verdict = judge(recordingOf(sighting({ ours: null, anchors: [NO_BOX] })));

    expect(verdict.findings[0]?.answer).toBe('refused');
    expect(verdict.red).toBe(0);
    expect(verdict.refused).toBe(1);
  });

  it('REFUSES when the sighting names no anchor at all, instead of trusting it', () => {
    const verdict = judge(recordingOf(sighting({ ours: null, anchors: [] })));

    expect(verdict.findings[0]?.answer).toBe('refused');
    expect(verdict.findings[0]?.says).toContain('no anchor');
  });

  it('holds a control with no layout to be undrawn, whatever it calls itself', () => {
    const verdict = judge(recordingOf(sighting({ ours: { ...NO_BOX, visible: true } })));

    expect(verdict.findings[0]?.answer).toBe('red');
  });

  it('holds a control the browser calls invisible to be undrawn, box or no box', () => {
    const verdict = judge(recordingOf(sighting({ ours: INVISIBLE })));

    expect(verdict.findings[0]?.answer).toBe('red');
  });

  describe('when the sighting is about what the control LOOKS like', () => {
    const wanted: Wanted = {
      codicon: 'codicon-circle-slash',
      color: 'rgb(133, 133, 133)',
      because: 'the product has this terminal as ended',
    };

    it('is green when the picture agrees with what the product believes', () => {
      const ours: Drawn = {
        ...SEEN,
        codicon: 'codicon-circle-slash',
        color: 'rgb(133, 133, 133)',
      };

      expect(judge(recordingOf(sighting({ scenario: 'S26', ours, wanted }))).findings[0]?.answer)
        .toBe('green');
    });

    it('is RED when the icon stayed behind the state -- which is what "залипло" is', () => {
      const stuck: Drawn = { ...SEEN, codicon: 'codicon-check', color: 'rgb(63, 162, 102)' };
      const verdict = judge(recordingOf(sighting({ scenario: 'S26', ours: stuck, wanted })));

      expect(verdict.findings[0]?.answer).toBe('red');
      expect(verdict.findings[0]?.says).toContain('codicon-check');
      expect(verdict.findings[0]?.says).toContain('codicon-circle-slash');
      // What the product believed, so the reader knows which of the two is wrong.
      expect(verdict.findings[0]?.says).toContain('ended');
    });

    it('is RED when the colour stayed behind, even where the icon caught up', () => {
      const half: Drawn = { ...SEEN, codicon: 'codicon-circle-slash', color: 'rgb(63, 162, 102)' };

      expect(judge(recordingOf(sighting({ scenario: 'S26', ours: half, wanted }))).findings[0]?.answer)
        .toBe('red');
    });

    it('still REFUSES a look nobody got, rather than reading its colour', () => {
      const verdict = judge(recordingOf(sighting({
        scenario: 'S26',
        ours: null,
        anchors: [NO_BOX],
        wanted,
      })));

      expect(verdict.findings[0]?.answer).toBe('refused');
    });
  });

  it('counts a whole run, and keeps every point in the order it was seen', () => {
    const verdict = judge(recordingOf(
      sighting({ point: 1 }),
      sighting({ point: 2, ours: null }),
      sighting({ point: 3, ours: null, anchors: [NO_BOX] }),
    ));

    expect(verdict.findings.map((one) => one.point)).toEqual([1, 2, 3]);
    expect([verdict.green, verdict.red, verdict.refused]).toEqual([1, 1, 1]);
  });

  it('carries the build through, because a picture belongs to the build that drew it', () => {
    const build = {
      editor: 'Cursor',
      version: '3.17.19',
      vscodeVersion: '1.128.0',
      commit: 'ae3a2b72',
      built: '2026-08-24',
    };

    expect(judge({ ...recordingOf(sighting()), build }).build).toEqual(build);
  });

  it('says nothing was looked at when a run recorded no sighting, and refuses it', () => {
    const verdict = judge(recordingOf());

    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.answer).toBe('refused');
    expect(verdict.refused).toBe(1);
  });
});
