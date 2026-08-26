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
 *
 * **What this file does NOT prove, and what was done about it once.** It holds
 * the judging half only. That the LOOKING half -- a real workbench, its DOM, the
 * colours read off it -- would notice a tab that disagreed with its row was an
 * assumption until 2026-08-26, because no run had ever produced a red S26. On
 * that day a positive control was put under it in a live VS Code 1.134.0 and
 * then taken out again: a stand-in extension decorated ONE tab through the same
 * `FileDecorationProvider` API the product colours tabs with, and in that single
 * run the sightings went 2 green before it, then RED for the decorated tab
 * ("coloured rgb(173, 128, 215) where rgb(134, 207, 134) was due") and GREEN for
 * the undecorated one, in the same look. The head of `run.mjs` carries the rest
 * of it. Nothing repeats that control, so it is a fact about that day.
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

  /**
   * A refusal is a sentence somebody reads instead of a number, so what it
   * calls the anchor has to be true.
   *
   * Measured 2026-08-26 in Cursor 3.17.19: both S26 sightings came back saying
   * "Not one of the 1 control(s) of the EDITOR'S OWN there was drawn either
   * (eyes-project 2 (codicon-check))" -- and that control is OURS. The row is
   * the anchor of an S26 sighting because it is the product's own belief
   * rendered by the editor's list, which is a different argument from S13's,
   * and a receipt that misstates which of the two it made is a receipt the next
   * reader acts on wrongly.
   */
  it('names the anchors for what they are, instead of calling our own row the editor own', () => {
    const row: Drawn = { ...NO_BOX, label: 'eyes-project 2', codicon: 'codicon-check' };
    const verdict = judge(recordingOf(sighting({
      scenario: 'S26',
      ours: null,
      anchors: [row],
      anchorsAre: 'the row the product drew in the list',
    })));

    expect(verdict.findings[0]?.answer).toBe('refused');
    expect(verdict.findings[0]?.says).toContain('the row the product drew in the list');
    expect(verdict.findings[0]?.says).not.toContain('of the editor\'s own');
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

    /**
     * The anchor of an S26 sighting is the ROW, and the row is where the colour
     * the tab is held to comes from. A row drawn with no colour in it therefore
     * leaves NOTHING to compare -- and a sighting that then answers green is
     * reporting the absence of a measurement as the success of one, which is
     * the one failure this whole apparatus exists to make impossible (I.1).
     *
     * It is reachable rather than theoretical: the row's colour is read off the
     * first `[class*=codicon-]` inside it, so a build that drew that icon any
     * other way -- an svg `iconPath`, a background image, a theme that puts the
     * icon in a pseudo-element -- would hand every S26 sighting a `null` and
     * turn the whole scenario permanently green while measuring nothing.
     */
    it('REFUSES a comparison the anchor could not supply, rather than passing it', () => {
      const nothingToCompare: Wanted = {
        codicon: null,
        color: null,
        because: 'the row for eyes-project 2 is drawn in null',
      };
      const ours: Drawn = { ...SEEN, codicon: 'codicon-terminal', color: 'rgb(134, 207, 134)' };

      const verdict = judge(recordingOf(sighting({ scenario: 'S26', ours, wanted: nothingToCompare })));

      expect(verdict.findings[0]?.answer).toBe('refused');
      expect(verdict.findings[0]?.says).toContain('nothing to compare');
      expect(verdict.green).toBe(0);
    });

    /**
     * S25 asks a question about IDENTITY rather than about colour: after a
     * person clicks "Show terminal" on the notification, the tab in front must
     * be the tab of the terminal the notification was about. A button that
     * brings up SOMEBODY ELSE'S terminal is the whole of the complaint, and it
     * is invisible to a judge that can only compare icons and colours.
     */
    it('is RED when what is drawn is the wrong thing, however right it looks', () => {
      const readme: Drawn = { ...SEEN, label: 'README.md', codicon: 'codicon-terminal', color: null };
      const verdict = judge(recordingOf(sighting({
        scenario: 'S25',
        ours: readme,
        wanted: {
          codicon: null,
          color: null,
          label: 'eyes-project 2',
          because: 'the notification was raised for eyes-project 2',
        },
      })));

      expect(verdict.findings[0]?.answer).toBe('red');
      expect(verdict.findings[0]?.says).toContain('README.md');
      expect(verdict.findings[0]?.says).toContain('eyes-project 2');
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
