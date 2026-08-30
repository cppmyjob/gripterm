import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A sentence this repository has measured FALSE may not come back.
 *
 * **The defect this exists for, found 2026-08-25.** `tools/gate.mjs` printed on
 * every run, green or red, that the live suites cannot run in Cursor, and it
 * closed the reason with `There is no configuration for this: it is what that
 * host does`. Measured the same day over 33 launches of the two editors: there
 * IS a configuration for it. Its name is `--classic`, it is a documented flag of
 * the fork's own binary, and under it the extension loaded in 12 launches out of
 * 12 -- 113 entries in `vscode.extensions.all` where a glass window answers 48.
 * The sentence was the conclusion of a measurement that a later measurement
 * overturned, and it went on being printed for a day afterwards.
 *
 * **Why that is worse than having written nothing.** A record that outlives its
 * refutation does not merely fail to inform: it actively stops the next reader
 * from checking, because it names the question closed and says so in the voice
 * of something measured. That reader would have had to repeat 33 launches to
 * find out otherwise.
 *
 * **Why a test rather than a careful rewrite.** The rewrite closes the instance.
 * The sentence itself is the class: it is quotable, it reads as settled, and the
 * three files that carried it copied it from one another. Nothing but a check
 * stops the fourth copy, and a check is one `git ls-files` and no editor.
 *
 * **What is deliberately NOT here, and it is the harder half.** Only sentences
 * that are false in EVERY context are listed. `registers no third-party
 * extension at all` is not here and must not be: measured 2026-08-25, it is true
 * of a glass window (48 entries, 5 launches out of 5) and false of the test host
 * as such (113 entries under `--classic`, 12 out of 12), so a rule forbidding
 * the words would forbid the true sentence along with the false one. The same
 * goes for `exits 0 on a failing run`: the exit code turned out to FLICKER --
 * `1, 0, 0, 1` in four identical consecutive launches -- and a sentence saying
 * so has to be able to quote what it corrects. Those two are held by the prose
 * of the three files instead, which is weaker, and is said here in those words
 * rather than left to look like coverage.
 *
 * `may reach the Claude Code extension` is the third of them, and it is not here
 * for the same reason (2026-08-30). Three files described
 * `gripterm.terminal.ideChannel` in exactly those words and a fourth in the same
 * words reordered; all four were wrong, because the setting governs the UNASKED
 * connection alone. But the words themselves are TRUE of a channel a person
 * raised by hand with `/ide`, which on CLI 2.1.245 is the only way that channel
 * was seen coming up at all -- so forbidding them would forbid the correction
 * along with the claim. What is listed below is the narrower thing the manifest
 * and the README said instead, which has no true reading in any redaction.
 *
 * The FOCUS PRICE of that same channel is the fourth, added the same day, and it
 * is the clearest case of all for why this list is not the only tool here. What
 * was written was `takes the focus away from the Gripterm panel every time you
 * send a prompt` -- and on 2026-08-20 that is what the owner saw, by hand, in
 * VS Code. Ш29 went looking for it again on 2026-08-30 with an instrument and
 * could NOT find it in Cursor: 163 samples over 25 s after a prompt was sent on
 * an open channel, 162 and 155 in the other two arms, nothing moving, against a
 * positive control that moved every field it watched. In VS Code only the
 * CONNECTING half was watched, and it moved nothing; SENDING in VS Code -- the
 * very editor and moment of the sighting -- was not watched at all, the message
 * budget having run out. So the sentence is REFUTED WHERE IT WAS LOOKED FOR and
 * NOT WITHDRAWN, and a repository-wide ban on the words would forbid the true
 * 2026-08-20 record along with the false present tense. What is checked instead
 * is narrower and is below: in the two texts a person OUTSIDE this repository
 * reads, that price may not be written in the present tense, and where it is
 * written at all it carries the day it was seen.
 *
 * **`gate/allowed-red.json` still carries both of them** (2026-08-25). It is the
 * owner's file, an admission of redness nobody but the owner may edit, and the
 * gate prints its opening block on every full run. That is an open item for the
 * owner, not an exemption this file grants.
 */

const REPO = resolve(__dirname, '..');

/**
 * This file, excluded from its own scan.
 *
 * A rule about a sentence has to spell the sentence out, so the register is the
 * one place in the repository where it may stand. Excluded by PATH rather than
 * by some cleverness about quoting: the exclusion is then visible, and a copy
 * that lands anywhere else -- including in another test -- is still caught.
 */
const THE_REGISTER = 'tests/refuted-claims-stay-refuted.test.ts';

/** Where a claim can be written down. Binaries are not read; a match in one would be a coincidence. */
const SCANNED = /\.(?:ts|js|mjs|cjs|json|md|ya?ml)$/u;

interface RefutedClaim {
  /** The sentence as it stood, verbatim. Matched as a substring, case-sensitively. */
  readonly said: string;
  /** What measured it false: the number, how many runs, and the date. */
  readonly refutedBy: string;
}

/**
 * One measurement, quoted by the two entries it refutes.
 *
 * The claim was written twice in two spellings, which is exactly the way the
 * first sentence in this register spread, so both spellings are listed and the
 * reason is written once rather than copied and left to drift.
 */
const IDE_CHANNEL_REFUTATION =
  'Ш29, 2026-08-30, thirteen windows raised across both editors: the setting closes nothing. With ' +
  '`gripterm.terminal.ideChannel: false` a `/ide` typed by hand connected anyway, and the agent named the file ' +
  'that was open and the line that was selected -- the token was minted for that run, so neither could be ' +
  'guessed. The other half is worse: with the setting ON the channel did not come up by itself either. `/ide` at ' +
  'the start of eight windows -- both editors, both positions of the setting -- showed `None` as the current ' +
  'choice, against a Claude Code extension that was installed, live and activated. What the setting really ' +
  'governs is `CLAUDE_CODE_AUTO_CONNECT_IDE`, which is auto-connection and nothing else, and CLI 2.1.245 with ' +
  'extension 2.1.251 performs none. THE CAVEAT TRAVELS WITH THE FACT: the measurement ran against a copy of the ' +
  'extension the run installed into a directory of its own, because the windows our runs open do not register ' +
  'Claude Code at all -- whether an ordinary installation behaves the same is NOT established. Versions: CLI ' +
  '2.1.245, extension 2.1.251, VS Code 1.135.0, Cursor 3.17.19.';

/**
 * Every sentence measured false, with the measurement that did it.
 *
 * The reason travels with the rule on purpose. A bare blacklist tells whoever
 * trips over it that the words are forbidden and not why, and the next thing
 * that person writes is the same claim in other words.
 */
const REFUTED: readonly RefutedClaim[] = [
  {
    said: 'There is no configuration for this',
    refutedBy:
      'Cursor 3.17.19, measured 2026-08-25 over 33 launches. `--classic` is the configuration: a documented ' +
      'flag of the fork`s own binary ("Disable glass mode and force classic windows"), and under it our ' +
      'extension was found in 12 launches out of 12, with 113 entries in `vscode.extensions.all` against the ' +
      '48 a glass window answers in 5 out of 5. It beats an explicitly requested `--glass`: 3 launches of ' +
      '`--glass --classic`, found in all 3.',
  },
  {
    said: 'broken in Cursor in a folderless window and sound in a window with a folder',
    refutedBy:
      'Ш16, 2026-08-25: `--classic` with NO folder missed 0 attempts of 10, measured TWICE. The folder is ' +
      'not the variable and never was -- it switches GLASS off as a side effect, because a path on the ' +
      'command line makes the fork`s `hasExplicitFirstWindowIntent` true and no first-window decision is ' +
      'taken, and on a fresh profile that decision is the only thing that turns glass on. The variable is ' +
      'the workbench: a glass window throws 10 of 10 (5 launches of 5), a window that is not glass throws ' +
      '0 of 10 (12 launches of 12 under `--classic`, 6 of 6 with a folder and no flag). Written out in ' +
      '`.vscode-test.mjs`, `tools/cursor-workbench.js`, `tests/cursor/workbench.test.ts` and ' +
      '`tests/cursor/new-group-below.js`.',
  },
  {
    said: 'off unless you turn on gripterm.terminal.ideChannel',
    refutedBy: IDE_CHANNEL_REFUTATION,
  },
  {
    // The same claim in the README`s markdown, which the plain spelling above
    // does not match: the setting`s name is in backticks there, and this rule
    // reads substrings and not prose.
    said: 'off unless you turn on `gripterm.terminal.ideChannel`',
    refutedBy: IDE_CHANNEL_REFUTATION,
  },
];

/**
 * Every file this repository keeps, as paths relative to its root.
 *
 * `--cached --others --exclude-standard` is "tracked, plus untracked, minus
 * ignored" -- the set a `git add -A` would end up with, which is the set a
 * reader of this repository can reach. Untracked files ARE included: a sentence
 * written into a file nobody has committed yet is the case this was written for.
 */
function filesOfTheRepository(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line.length > 0 && SCANNED.test(line) && line !== THE_REGISTER);
}

/** Where each refuted sentence still stands, if it stands anywhere. */
function whereTheyStillStand(files: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const path of files) {
    const text = readFileSync(join(REPO, path), 'utf8');
    for (const claim of REFUTED) {
      if (text.includes(claim.said)) {
        found.push(`${path}: "${claim.said}" -- ${claim.refutedBy}`);
      }
    }
  }
  return found;
}

/**
 * The `cursor-live` entry of the gate's own list of what it does not cover.
 *
 * Read as TEXT and not imported, for the reason `every-label-is-run.test.ts`
 * gives about the runner config: importing `tools/gate.mjs` would run a gate.
 * Sliced from one entry's name to the next, which is crude and crude in the
 * safe direction -- a record written some other way is not seen here.
 *
 * It THROWS when the entry is not there, rather than answering an empty string.
 * An absent input that reads like a clean measurement is how this repository
 * last talked itself into a fact that was not checked (`grep ... || echo 0`
 * printed 0 because the file did not exist).
 */
function theCursorLiveRecord(): string {
  const text = readFileSync(join(REPO, 'tools', 'gate.mjs'), 'utf8');
  const from = text.indexOf('name: \'cursor-live\'');
  if (from === -1) {
    throw new Error('tools/gate.mjs has no `cursor-live` entry -- this rule is about one, and cannot read one that is not there');
  }
  const to = text.indexOf('name: \'', from + 1);
  return to === -1 ? text.slice(from) : text.slice(from, to);
}

/**
 * The manifest's own description of `gripterm.terminal.ideChannel`.
 *
 * The settings UI of the editor is where this sentence is read by somebody who
 * has never opened this repository, which is why it is checked and the five
 * source comments carrying the same price are not. It THROWS when the key is
 * gone, for the reason `theCursorLiveRecord` gives: an absent input that reads
 * like a clean measurement is how this repository last talked itself into a
 * fact nobody had checked.
 */
function theIdeChannelSetting(): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO, 'packages', 'extension', 'package.json'), 'utf8')
  ) as { contributes: { configuration: { properties: Record<string, { markdownDescription?: string }> } } };
  const described = manifest.contributes.configuration.properties['gripterm.terminal.ideChannel'];
  if (described?.markdownDescription === undefined) {
    throw new Error('the manifest no longer describes gripterm.terminal.ideChannel -- this rule is about that description, and cannot read one that is not there');
  }
  return described.markdownDescription;
}

/**
 * The README row that says what an agent loses under the own engine.
 *
 * Sliced from one row to the next, the same crude way and in the same safe
 * direction as `theCursorLiveRecord`: a price written into some other row is not
 * seen here, and a row that has been renamed throws rather than answering an
 * empty string.
 */
function theReadmeRowAboutTheChannel(): string {
  const text = readFileSync(join(REPO, 'README.md'), 'utf8');
  const from = text.indexOf('| What other extensions add to a terminal |');
  if (from === -1) {
    throw new Error('README.md has no row named `What other extensions add to a terminal` -- this rule reads one, and cannot read one that is not there');
  }
  const to = text.indexOf('| History |', from);
  return to === -1 ? text.slice(from) : text.slice(from, to);
}

/** Where that channel is described to somebody who will never read this code. */
function theTextsAPersonReads(): Readonly<Record<string, string>> {
  return {
    'packages/extension/package.json': theIdeChannelSetting(),
    'README.md': theReadmeRowAboutTheChannel(),
  };
}

describe('a claim this repository measured false', () => {
  it('is written nowhere in it', () => {
    expect(whereTheyStillStand(filesOfTheRepository())).toStrictEqual([]);
  });

  it('is not merely unsaid in the gate`s record, but corrected there by name', () => {
    // The rule above catches the sentence coming back word for word. It does not
    // catch the other way the same lie returns: the correction deleted, and the
    // record left silent about the configuration that exists -- which the next
    // reader takes for the same "there is none" the sentence said out loud.
    expect(theCursorLiveRecord()).toContain('--classic');
  });

  it('does not go on calling open the half of its question the owner has answered', () => {
    // The other way a record outlives what is true of it, and it needs no false
    // sentence at all: the question stands unchanged while half of it has been
    // settled, so a reader counts as open something that was decided.
    //
    // WHAT WAS ANSWERED, 2026-08-25: what the `cursor` stage should measure. The
    // owner settled the first half of it -- the ordinary window is the one he
    // works in -- and `.vscode-test.mjs` has said so since. What is still open
    // is the COST: 4 min 30 s onto a full gate measured against a ceiling of
    // ten. The record must say which half is which, in the words the runner
    // config uses, so that the two cannot drift apart in silence.
    const record = theCursorLiveRecord();
    expect(record).not.toContain('The second is the owner`s to answer and was open on');
    expect(record).toContain('the ordinary window is the one he works in');
  });

  it('does not charge a person the focus price in the present tense, the once it was looked for again having failed to find it', () => {
    // Named rather than counted, and in two assertions rather than one, because
    // the two failures read differently: a present tense that outlived its
    // re-measurement, and a price quoted with no day attached to it.
    const texts = Object.entries(theTextsAPersonReads());

    // The present tense is what makes it false: as a fact of today it was looked
    // for on 2026-08-30 and not found where anybody looked.
    expect(texts.filter(([, text]) => text.includes('takes the focus')).map(([where]) => where)).toEqual([]);

    // And a price without its date cannot be checked by the next reader at all.
    // Conditional on purpose: a text that stops mentioning the focus owes no
    // date, because a later measurement may withdraw the price outright -- what
    // this refuses is the quotation without the day, not the silence.
    expect(
      texts
        .filter(([, text]) => text.includes('focus') && !text.includes('2026-08-20'))
        .map(([where]) => where)
    ).toEqual([]);
  });

  it('is looked for over a repository this reader can really see, so that neither rule above is about an empty list', () => {
    // Both assertions above are `[] === []` when the listing breaks, and a broken
    // listing is silent -- the failure `named-tests-exist.test.ts` was bitten by
    // and guards against in the same words.
    expect(filesOfTheRepository().length).toBeGreaterThan(100);
    expect(theCursorLiveRecord().length).toBeGreaterThan(500);
  });
});
