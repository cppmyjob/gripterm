import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Answer, Verdict } from './judge';
import type { StartVerdict } from './start-budget';

/**
 * The budget of admitted redness: a function from a verdict, a document and a
 * date to a list of refusals.
 *
 * It is cut here for the same reason `judge.ts` is cut from `run.mjs`. The
 * measurer needs an editor and four minutes; the judge needs a recording; this
 * needs neither. So the whole of "what the gate admits and what it refuses" is
 * settled by `allowance.test.ts` in under a second, and the gate is left doing
 * the one thing only it can do -- running the stand and handing over what came
 * back.
 *
 * **The rule, in one line.** A point that is not green passes only if a line of
 * the document names it, admits the same answer, and came back no worse than
 * the number that line admits. A point that comes back GREEN is refused -- take
 * the line out -- unless its line says in writing that this point has been
 * measured both ways on the same code.
 *
 * **Why a ceiling and not an exact number, which is what was asked for.** The
 * design this was built to was stricter: a point red by LESS than its line said
 * was to be refused too, so that a budget nobody tightens could not become a
 * permission with no end. That rule presumes the stand's answer is a function of
 * the product. Measured 2026-08-25, runs of `pnpm run test:stand` on one
 * revision, no other change between them (`.` is green):
 *
 *     point:        0     1     2     3     4     5     6     7     8
 *     run 1  00:26  .     .     .     1     1     .     3     3     .
 *     run 2  01:38  .     2     .     2     1     .     3     3     .
 *     run 3  01:44  .     2     .     2     1     .     3     3     .
 *     run 4  01:46  .     2     .     2     1     .     3     3     .
 *     run 5  01:58  .     2     .     3     1     .     3     2     .
 *     run 6  02:20  .     .     .     1     1     .     3     3     .
 *
 * Six is a FLOOR and not a count, and the reason is in the stand itself:
 * `run.mjs` `prepare()` deletes `.vscode-test/stand-output/` before every run,
 * so only the last run's numbers exist as a file. Row 6 is that file; rows 1 to
 * 5 are transcribed from runs nobody can re-read. `gate/allowed-red.json` says
 * the same thing at more length, with the receipt that dates row 6.
 *
 * Point 1 -- the accumulating editor groups, the defect the stand was built for
 * -- came back green in two runs of six; point 3 moved 1, 2, 2, 2, 3, 1 and
 * point 7 moved 3, 3, 3, 3, 2, 3. BOTH directions of the exact rule fire on that
 * noise: run 5 would have been refused for being BETTER at point 7, and runs 1
 * and 6 for being better at points 1 and 3. It is the same intermittency the plan already
 * records for the staircase (seven sittings went 2, 2, 4, 5, 6, 7, 8 and the
 * second was clean) and the same shape the plan's own Ш9 anticipates: "if the
 * miss is really one in ten, a green run is unreachable, and the rule has to be
 * `the miss rate did not grow`". An exact number over a random variable is a
 * coin, and a gate that is a coin teaches a person to run it again instead of
 * reading it -- which is the one thing the plan says a gate must never do.
 *
 * So the exact rule is kept where it is sound and named where it is not: a line
 * with `atMost` equal to what the point always returns IS the exact rule, and
 * `mayBeGreen` is a per-line escape that has to carry the numbers behind it in
 * `seen`. The pressure to shrink then rests on `expires` and `cap`, which are
 * machine-enforced and need no reproducibility at all.
 *
 * **What this cannot do, said here rather than found out later.** It compares a
 * count of things that went wrong, not a magnitude. A strip that improves from
 * 0.906 of its family to 0.400 is still one wrong sitting, and this will call
 * that unchanged. The magnitude lives in `measured`, which nothing here reads,
 * and only a person notices when it moves.
 */

/**
 * Where the document lives, named once so that the gate and the suite cannot
 * disagree about which file is the budget.
 *
 * Found by climbing rather than counted in `..`s, because this file is read from
 * two depths: `tests/stand/` by ts-jest, and `out/tests/stand/` by the gate,
 * which loads the compiled copy. A fixed number of levels is right in exactly
 * one of those two, and wrong silently in the other -- it would name a path that
 * does not exist and the gate would die reading its own budget.
 */
export const ALLOWANCES = join(repositoryRoot(), 'gate', 'allowed-red.json');

function repositoryRoot(): string {
  for (let at = resolve(__dirname); ; at = dirname(at)) {
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) {
      return at;
    }
    if (dirname(at) === at) {
      throw new Error(`no pnpm-workspace.yaml above ${__dirname}, so there is no repository to find the budget in`);
    }
  }
}

/** One admitted point. Everything a machine reads is required; nothing is defaulted. */
export interface Allowance {
  readonly point: number;
  /** What the point asserts, as the judge words it. A label for a reader; nothing compares it. */
  readonly says: string;
  /** The answer admitted. Never `green`: a line admitting green admits nothing. */
  readonly answer: Exclude<Answer, 'green'>;
  /** The most `Finding.violations` this point may come back with. Worse is refused. */
  readonly atMost: number;
  /**
   * Whether a GREEN answer at this point is admitted too.
   *
   * `false` everywhere it can be: a point that came back green is a defect that
   * may be over, and its line has to go so that the cap makes room for the next
   * one. `true` is for a point measured BOTH ways on one revision, and the runs
   * that measured it belong in `seen` beside it.
   */
  readonly mayBeGreen: boolean;
  /** The numbers this point actually came back with, and when. Read by people. */
  readonly seen: string;
  /** The magnitude a person needs, in words. Nothing here reads it. */
  readonly measured: string;
  /** What closes this, so that a reader knows whom the line is waiting for. */
  readonly why: string;
  /**
   * Who decided that this redness may stand, in their own name.
   *
   * It answers "who let the build be red here", asked a month later by somebody
   * who was not in the room. It names the DECIDER and nobody else -- an agent,
   * an orchestrator, a person. Naming the owner here when the owner was never
   * asked is worse than leaving the field blank: a blank reads as a gap and a
   * name reads as a signature, so `readAllowances` refuses that one sentence
   * outright. See `ratifiedBy`.
   */
  readonly allowedBy: string;
  /**
   * Who ratified it afterwards, or `null` for "nobody has, and the owner has
   * not seen this line".
   *
   * Two fields rather than one, because they are two facts and they come apart
   * in exactly the way that matters: an agent can admit redness in the middle
   * of a step, and the owner can be told about it a day later, or never. One
   * field forces whoever writes the line to choose which of the two to say, and
   * 2026-08-25 is the measurement of which one gets chosen -- all five lines of
   * `gate/allowed-red.json` were written as "owner, through the Ш6
   * orchestrator", and the owner had not been asked.
   *
   * `null` is not "unknown" and not "not applicable". It is the load-bearing
   * value: it says the permission beside it is one agent's decision standing
   * unreviewed, which is why the gate prints it on every run.
   */
  readonly ratifiedBy: string | null;
  /**
   * How many times `expires` has been moved on this line, from 0.
   *
   * `expires` was the only thing forcing anybody to act, and it forces the LINE
   * to die rather than the owner to answer -- while the date itself is moved by
   * the same party that never asked, for free and as often as it likes. Nothing
   * counted that, so an unratified line could live for ever in fortnight steps,
   * and every step would look like an ordinary diff.
   *
   * The rule is one renewal: unratified, a line may be extended ONCE; a second
   * extension needs a name in `ratifiedBy`. Refused by `standingAllowances`, so
   * it needs no verdict and fires under a bare `npx jest`.
   *
   * **What it costs.** The counter is written by hand and can be written down.
   * What it buys is that an uncounted renewal is then a deliberate lie sitting
   * in a diff, where the defect it replaces was forgetfulness.
   */
  readonly renewals: number;
  /** `YYYY-MM-DD`. The first day on which this line no longer stands. */
  readonly expires: string;
}

export interface AllowanceDocument {
  /** The document explaining itself, in a file format that has no comments. */
  readonly what: readonly string[];
  /** How many lines may live at once. */
  readonly cap: number;
  readonly allowances: readonly Allowance[];
  /**
   * The other kind of line: a ceiling on a RATE rather than on a point.
   *
   * `cap` deliberately does not count these. It bounds how much of the STAND may
   * be red at once, and a rate line is not redness admitted -- today's is
   * `atMost: 0`, which admits nothing and asserts everything. What bounds this
   * array instead is `ratesAgainstBudget`, which refuses a ceiling over a check
   * nothing measures: a line here cannot outlive the probe it is about.
   */
  readonly rates: readonly RateCeiling[];
}

/**
 * A ceiling on how often one editor command may MISS, out of a named number of
 * attempts.
 *
 * **Why the budget needed a second shape.** The stand answers in points -- named
 * things that went wrong -- and Ш9 measures something a point cannot hold: the
 * customer's editor is a fork, and the fork's `workbench.action.newGroupBelow`
 * was measured on 2026-08-22 to do nothing at all on one call in ten. The plan
 * anticipated exactly that and named the rule for it: "if the miss is really one
 * in ten, a green run is unreachable, and the rule has to be `the miss rate did
 * not grow`". A rate is not a count of defects; it is a fraction, and the
 * denominator is part of the fact.
 *
 * Everything about a line's LIFE -- the date, the renewal counter, who admitted
 * it and who has not -- is the same here as on an allowance, and is read by the
 * same code, so that a Cursor ceiling nobody tightens dies on its date exactly
 * as an admitted point does.
 */
export interface RateCeiling {
  /** The check this bounds, spelled as the probe spells it. */
  readonly check: string;
  /** What the check asserts, for a reader. Nothing compares it. */
  readonly says: string;
  /**
   * How many attempts the ceiling was measured over.
   *
   * The denominator, held because this file stores only the numerator: nought
   * misses out of one attempt and nought out of ten are not the same fact, and
   * the first is what a probe that quietly gave up looks like. A run of fewer
   * attempts than this is refused rather than compared.
   */
  readonly of: number;
  /** The most misses admitted, out of `of`. Worse is refused; better is not. */
  readonly atMost: number;
  /** The numbers this check actually came back with, and when. Read by people. */
  readonly seen: string;
  /** The magnitude a person needs, in words. Nothing here reads it. */
  readonly measured: string;
  /** What closes this line, so that a reader knows whom it is waiting for. */
  readonly why: string;
  /** Who decided this ceiling may stand, in their own name. See `Allowance.allowedBy`. */
  readonly allowedBy: string;
  /** Who ratified it, or `null` for "nobody has". See `Allowance.ratifiedBy`. */
  readonly ratifiedBy: string | null;
  /** How many times `expires` has been moved on this line, from 0. */
  readonly renewals: number;
  /** `YYYY-MM-DD`. The first day on which this line no longer stands. */
  readonly expires: string;
}

/** What a probe came back with, for one check. */
export interface RateMeasured {
  readonly check: string;
  /** How many attempts were made. Compared with `RateCeiling.of`. */
  readonly attempts: number;
  /** How many of them missed. Compared with `RateCeiling.atMost`. */
  readonly misses: number;
}

export interface Refusal {
  /** The point refused, or `null` when the refusal is about the document itself. */
  readonly point: number | null;
  readonly because: string;
}

const A_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ANSWERS: readonly string[] = ['red', 'unmeasured'];

/**
 * The owner, however a line spells them.
 *
 * Deliberately crude, and it errs towards refusing. This is the one sentence
 * the file has already been written wrongly with, so a line that so much as
 * names the owner as its authority has to carry a ratification beside it.
 * Whoever needs to write "the owner was asked and declined to look" writes that
 * in `why`, where nothing mistakes it for a signature.
 */
const NAMES_THE_OWNER = /\bowners?\b/iu;

/** A day inside a sentence, as opposed to a field that is only a day. */
const A_DAY_INSIDE = /\b\d{4}-\d{2}-\d{2}\b/u;

/**
 * A place a reader can go and look: a commit id, a path with a `/` in it, a
 * bare filename with an extension this repository uses, or a URL.
 *
 * Crude on purpose, and it checks the SHAPE of a citation and nothing else. It
 * cannot tell whether the commit exists, whether the file says what the line
 * claims, or whether the conversation happened -- a string carries none of
 * that, and pretending otherwise would be the very defect this file is about.
 * What it converts is "type the word owner" into "type something a reader can
 * open", which is worth that and no more.
 *
 * RESOLVING the citation was considered and refused. `git cat-file -e` would
 * turn a shape check into an existence check, but it costs the suite its
 * ability to run on a tree without the relevant history -- a shallow clone, or
 * a branch that does not carry the ratifying commit -- and it would force every
 * ratification to BE a commit, when a line of a register or a file is a
 * perfectly good place to have said something. The price was judged higher than
 * the forgery it prevents, since whoever will type a name will type a sha.
 */
const A_PLACE = /\b[0-9a-f]{7,40}\b|[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:md|txt|json|ts|js|mjs|cjs|sh)\b|\bhttps?:\/\/\S+/u;

/**
 * The document, or a throw naming what is wrong with it.
 *
 * A throw and not a refusal list, and the difference is deliberate: a refusal is
 * something the gate reports about the product, while a malformed budget is
 * something wrong with the gate's own instructions. Read leniently, a missing
 * `expires` would be a line that never expires and a missing `atMost` a line
 * that admits any number -- which is to say the file would grant more the worse
 * it was written.
 */
export function readAllowances(text: string): AllowanceDocument {
  const parsed: unknown = JSON.parse(text);
  const document = asRecord(parsed, 'the document');
  const cap = document.cap;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) {
    throw new Error(`the document's \`cap\` is ${JSON.stringify(cap)}, and it must be a whole number of lines`);
  }
  const rows = document.allowances;
  if (!Array.isArray(rows)) {
    throw new Error('the document has no `allowances` array');
  }

  const seen = new Set<number>();
  const allowances = rows.map((row, at) => {
    const line = asRecord(row, `allowance ${String(at + 1)}`);
    const point = line.point;
    if (typeof point !== 'number' || !Number.isInteger(point)) {
      throw new Error(`allowance ${String(at + 1)} has \`point\` ${JSON.stringify(point)}, which is not a point of the stand`);
    }
    if (seen.has(point)) {
      throw new Error(`the document admits point ${String(point)} twice, and two lines about one point cannot both be the budget`);
    }
    seen.add(point);

    const answer = line.answer;
    if (typeof answer !== 'string' || !ANSWERS.includes(answer)) {
      throw new Error(
        `allowance ${String(at + 1)} admits ${JSON.stringify(answer)}. A line may admit ${ANSWERS.join(' or ')}; ` +
          'a line admitting green admits nothing, since a green point needs no admission.'
      );
    }
    const atMost = line.atMost;
    if (typeof atMost !== 'number' || !Number.isInteger(atMost) || atMost < 1) {
      throw new Error(`allowance ${String(at + 1)} has \`atMost\` ${JSON.stringify(atMost)}, and an admitted point may go wrong at least once`);
    }
    const mayBeGreen = line.mayBeGreen;
    if (typeof mayBeGreen !== 'boolean') {
      throw new Error(
        `allowance ${String(at + 1)} has \`mayBeGreen\` ${JSON.stringify(mayBeGreen)}. It says whether a green answer ` +
          'at this point is admitted too, and leaving it out would decide that by default rather than in writing.'
      );
    }
    const what = `allowance ${String(at + 1)}`;
    const { allowedBy, ratifiedBy, renewals, expires } = deadlineAndSignature(line, what);

    return {
      point,
      says: text_(line, 'says', what),
      answer: answer as Exclude<Answer, 'green'>,
      atMost,
      mayBeGreen,
      seen: text_(line, 'seen', what),
      measured: text_(line, 'measured', what),
      why: text_(line, 'why', what),
      allowedBy,
      ratifiedBy,
      renewals,
      expires,
    };
  });

  return { what: whatOf(document), cap, allowances, rates: readRates(document.rates) };
}

/**
 * The four fields EVERY line of this document carries, whatever the line is
 * about, read in one place so that the two kinds cannot drift apart.
 *
 * It was written by extracting it rather than by designing it: the rules here
 * are the ones `readAllowances` already held over an admitted point, and the
 * rate ceilings of Ш9 have to be held to the same ones -- or the newer kind of
 * line becomes the cheap place to put a permission nobody dated. What a reader
 * can rely on is that this document has no second answer to "how long may this
 * stand" and no second answer to "who said so".
 *
 * @param line the object as it stands in the file
 * @param what how to name it in a refusal -- `allowance 2`, `rate 1`
 */
function deadlineAndSignature(
  line: Record<string, unknown>,
  what: string
): { allowedBy: string, ratifiedBy: string | null, renewals: number, expires: string } {
  const expires = line.expires;
  if (typeof expires !== 'string' || !A_DATE.test(expires) || Number.isNaN(Date.parse(expires))) {
    throw new Error(
      `${what} has \`expires\` ${JSON.stringify(expires)}. Every line stops working on a day ` +
        'named as YYYY-MM-DD -- a workaround with no expiry is a note, not a deadline (II.6).'
    );
  }
  const renewals = line.renewals;
  if (typeof renewals !== 'number' || !Number.isInteger(renewals) || renewals < 0) {
    throw new Error(
      `${what} has \`renewals\` ${JSON.stringify(renewals)}. It counts how many times ` +
        '`expires` has been moved on this line, from 0. Leaving it out would make a date somebody moved twice ' +
        'indistinguishable from one nobody has touched.'
    );
  }
  const ratifiedBy = line.ratifiedBy;
  if (ratifiedBy !== null && (typeof ratifiedBy !== 'string' || ratifiedBy.trim().length === 0)) {
    throw new Error(
      `${what} has \`ratifiedBy\` ${JSON.stringify(ratifiedBy)}. It is the name of whoever ` +
        'ratified this line, or `null` for "nobody has, and the owner has not seen it". Leaving the key out ' +
        'would let silence be read as either one.'
    );
  }
  if (ratifiedBy !== null && !(A_DAY_INSIDE.test(ratifiedBy) && A_PLACE.test(ratifiedBy))) {
    throw new Error(
      `${what} has \`ratifiedBy\` ${JSON.stringify(ratifiedBy)}, which names somebody but ` +
        'does not say WHEN they said it or WHERE it can be read. A ratification carries a day as YYYY-MM-DD and ' +
        'a place to go and look -- a commit id, a path, a file, a URL. The shape is all that is checked here: ' +
        'nothing in this file can tell whether the place says what the line claims, and it does not pretend to.'
    );
  }
  const allowedBy = text_(line, 'allowedBy', what);
  if (ratifiedBy === null && NAMES_THE_OWNER.test(allowedBy)) {
    throw new Error(
      `${what} says it was allowed by ${JSON.stringify(allowedBy)} while \`ratifiedBy\` is ` +
        'null, which is to say nobody has ratified it and the owner has not seen it. A line may not put its ' +
        'own decision on the owner and record no ratification for it: name whoever actually decided in ' +
        '`allowedBy`, and put the owner in `ratifiedBy` on the day they agree.'
    );
  }
  return { allowedBy, ratifiedBy, renewals, expires };
}

/**
 * The rate ceilings, or a throw naming what is wrong with them.
 *
 * **Absent is legal here, and this is the one place in this file where absence
 * is.** Everywhere else a missing field would make the document grant MORE the
 * worse it was written -- a missing `expires` is a line that never dies, a
 * missing `atMost` a line that admits any number. A missing `rates` grants
 * nothing at all: `ratesAgainstBudget` refuses every check it is handed that no
 * line admits, so a document with no rates in it refuses the whole Cursor
 * strip. The asymmetry is deliberate, and it is what keeps a budget written
 * before Ш9 readable by the code that came after it.
 *
 * @param value whatever stood at `rates` in the file
 */
function readRates(value: unknown): readonly RateCeiling[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`the document's \`rates\` is ${JSON.stringify(value)}, and it must be an array of ceilings`);
  }
  const named = new Set<string>();
  return value.map((row, at) => {
    const what = `rate ${String(at + 1)}`;
    const line = asRecord(row, what);
    const check = text_(line, 'check', what);
    if (named.has(check)) {
      throw new Error(
        `the document bounds ${JSON.stringify(check)} twice, and two ceilings over one check cannot both be the budget`
      );
    }
    named.add(check);

    const of = line.of;
    if (typeof of !== 'number' || !Number.isInteger(of) || of < 1) {
      throw new Error(
        `${what} has \`of\` ${JSON.stringify(of)}. A rate is a fraction and this file stores only its ` +
          'numerator, so the number of attempts it was measured over is written down beside it: nought misses ' +
          'out of one and nought out of ten are not the same fact.'
      );
    }
    const atMost = line.atMost;
    if (typeof atMost !== 'number' || !Number.isInteger(atMost) || atMost < 0 || atMost > of) {
      throw new Error(
        `${what} has \`atMost\` ${JSON.stringify(atMost)}, which is not a number of misses out of ` +
          `${String(of)}. Nought is a legal ceiling here, and the commonest one: unlike an admitted point, a rate ` +
          'line is written whether or not anything is wrong, because its job is to catch the day it becomes wrong.'
      );
    }

    const { allowedBy, ratifiedBy, renewals, expires } = deadlineAndSignature(line, what);
    return {
      check,
      says: text_(line, 'says', what),
      of,
      atMost,
      seen: text_(line, 'seen', what),
      measured: text_(line, 'measured', what),
      why: text_(line, 'why', what),
      allowedBy,
      ratifiedBy,
      renewals,
      expires,
    };
  });
}

/**
 * What is wrong with the budget itself, with no verdict anywhere in sight.
 *
 * The half of the rule that does not need an editor, four minutes or a stand,
 * which is exactly why it is separate: `allowance.test.ts` calls it against the
 * real file on every `npx jest`, so the day a line comes due the suite goes red
 * on its own. A deadline that only a full gate could notice would be a deadline
 * behind a ten-minute door.
 */
export function standingAllowances(document: AllowanceDocument, today: string): readonly Refusal[] {
  const refusals: Refusal[] = [];

  if (document.allowances.length > document.cap) {
    refusals.push({
      point: null,
      because:
        `the budget has ${String(document.allowances.length)} lines live, and the cap is ${String(document.cap)}. ` +
        'A new admission is written after an old one is taken out, not beside it.',
    });
  }

  /*
   * The rate ceilings, held to the same date and the same renewal counter.
   *
   * They come through this function rather than through the Cursor stage's own
   * judge on purpose: `allowance.test.ts` calls this against the real file on
   * every `npx jest`, so a Cursor ceiling nobody tightened dies on its date in
   * under a second with no editor -- instead of thirty seconds into a stage
   * that opens a window, once a fortnight, on somebody's desktop. It is the
   * same argument that put the points' deadline here.
   *
   * The refusal carries `point: null` because a rate is not a point of the
   * stand, and the check it is about is named in the sentence.
   */
  for (const line of document.rates) {
    if (today >= line.expires) {
      refusals.push({
        point: null,
        because:
          `the ceiling on ${line.check} was admitted until ${line.expires} by ${line.allowedBy} ` +
          `(${line.ratifiedBy === null ? 'ratified by nobody since' : `ratified by ${line.ratifiedBy}`}), and that ` +
          `line expired on ${line.expires}. What closes it: ${line.why}. Measure it again and write down what ` +
          'came back, or have the owner move the date in gate/allowed-red.json with a reason.',
      });
    }
    /*
     * The renewal cap, and it applies only where there is a permission to cap.
     *
     * `renewals` exists so that a line ADMITTING redness cannot live for ever in
     * fortnight steps taken by the party that never asked. A ceiling of nought
     * admits nothing -- it is an assertion that carries a date only because the
     * fork it was measured on ships every few days, so the NUMBER goes stale
     * while the check keeps passing. Capping the renewals of a green line would
     * mean asking the owner to sign, every eight weeks, for a check that has
     * never once been red: it teaches signing as a way to make a colour go away,
     * which is the habit this whole document exists against. `expires` still
     * fires, and that is the pressure that belongs here -- re-measure, do not
     * ratify.
     */
    if (line.atMost > 0 && line.ratifiedBy === null && line.renewals >= 2) {
      refusals.push({
        point: null,
        because:
          `the ceiling on ${line.check} admits ${String(line.atMost)} miss(es), has been renewed ` +
          `${String(line.renewals)} times, and nobody has ratified it. An unratified line that admits redness may ` +
          'be extended ONCE.',
      });
    }
  }

  for (const line of document.allowances) {
    if (today >= line.expires) {
      refusals.push({
        point: line.point,
        because:
          `point ${String(line.point)} was admitted until ${line.expires} by ${line.allowedBy} ` +
          `(${line.ratifiedBy === null ? 'ratified by nobody since' : `ratified by ${line.ratifiedBy}`}), and that ` +
          `line expired on ${line.expires}. What closes it: ${line.why}. Fix the point and delete the line, or have ` +
          'the owner move the date in gate/allowed-red.json with a reason.',
      });
    }
    if (line.ratifiedBy === null && line.renewals >= 2) {
      refusals.push({
        point: line.point,
        because:
          `point ${String(line.point)} has been renewed ${String(line.renewals)} times and nobody has ratified it. ` +
          'An unratified line may be extended ONCE. A second extension is the party that never asked moving its ' +
          'own deadline again, so it takes a name in `ratifiedBy` -- or the point fixed and the line deleted. ' +
          'The count is written by hand and can be written down; doing so is then a lie in a diff, which is the ' +
          'whole of what this buys.',
      });
    }
  }

  return refusals;
}

/**
 * Which workbench of the fork a run says it was measured in, and how it knows.
 *
 * The shape only, spelled here rather than imported: the reading is done by
 * `tools/cursor-workbench.js`, which is CommonJS because a Mocha file inside an
 * extension host has to require it with nothing compiled. What this file needs
 * of it is two strings.
 */
export interface WorkbenchSaid {
  /** `classic`, `glass`, or `unknown` -- never a guess at the third. */
  readonly is: string;
  /** The two readings, in words, so that a refusal can quote them. */
  readonly because: string;
}

/**
 * The workbench the rate ceilings in `gate/allowed-red.json` were measured in.
 *
 * A constant here rather than a field on each ceiling, and that is a smaller
 * claim than it looks: every rate line in that document was measured in the same
 * window on 2026-08-25, and the day one of them is not, this is where the
 * difference goes -- as a field on `RateCeiling`, which is a change to the
 * BUDGET and belongs to whoever ratifies budgets. It is `classic` because that
 * is the workbench the owner works in, checked by the owner on his own profile
 * on 2026-08-25, and not because it is the one the stage happens to get.
 */
export const THE_WORKBENCH_THE_RATES_WERE_MEASURED_IN = 'classic';

/** What the gate may say about the Cursor strip, and whether it may say it. */
export interface CursorJudgement {
  /**
   * Whether the numbers belong to a window at all.
   *
   * `false` is the third answer, and it is neither green nor "so many misses of
   * so many". A caller that prints a rate when this is `false` is naming a
   * defect of the product for a run that measured a different workbench.
   */
  readonly measured: boolean;
  readonly refusals: readonly Refusal[];
}

/**
 * Everything the gate refuses about the Cursor strip's run, workbench first.
 *
 * **Why the workbench comes before the arithmetic.** A rate is a fraction whose
 * denominator is the attempts and whose SUBJECT is the window they were made in.
 * Cursor has two workbenches and its API names neither; measured 2026-08-25 over
 * 33 launches, `newGroupBelow` missed 10 of 10 in the glass one and 0 of 10
 * outside it. Which one the stage gets is decided today by an argument that is
 * there for something else -- a folder added for `newGroupBelow` that switches
 * glass off as a side effect. So the day the window changes, comparing the
 * numbers anyway would print "10 misses of 10" against a ceiling of nought and
 * send somebody after a defect of the product that is a fact about a window.
 *
 * **So the numbers are not compared at all in that case, and that is the point.**
 * Not compared and reported as worse; not compared and reported as anything. An
 * unmeasured run and a failed one are two different facts -- the rule
 * `verdictAgainstAllowances` already holds for a point nothing judged -- and a
 * rate filed under the wrong window is neither of them. The colour it costs is
 * paid on purpose: an unestablished workbench is RED, exactly as a missing
 * `rate.json` is RED, because the alternative is a gate that guesses.
 *
 * @param measured what the probe wrote down, one entry per check
 * @param said which workbench the probe read itself into, or `null` where it said nothing
 * @param document the budget as read from `gate/allowed-red.json`
 */
export function cursorAgainstBudget(
  measured: readonly RateMeasured[],
  said: WorkbenchSaid | null,
  document: AllowanceDocument
): CursorJudgement {
  if (said === null) {
    return {
      measured: false,
      refusals: [
        {
          point: null,
          because:
            'this run did not say which workbench of the fork it measured, and the fork has two whose answers ' +
            'to the same command differ completely. Its numbers are not judged: there is nothing to file them ' +
            'under. A `rate.json` with no workbench in it was written by a stage older than this reading -- ' +
            'run the stage again.',
        },
      ],
    };
  }
  if (said.is !== THE_WORKBENCH_THE_RATES_WERE_MEASURED_IN) {
    return {
      measured: false,
      refusals: [
        {
          point: null,
          because:
            `this run measured the "${said.is}" workbench of the fork, and every ceiling in this budget was ` +
            `measured in the "${THE_WORKBENCH_THE_RATES_WERE_MEASURED_IN}" one -- the workbench the owner ` +
            'works in. Its numbers are NOT judged here and are not evidence about the product: the same ' +
            'command answers 10 misses of 10 in glass and none of 10 outside it (2026-08-25, 33 launches). ' +
            `What this run read: ${said.because}`,
        },
      ],
    };
  }
  return { measured: true, refusals: ratesAgainstBudget(measured, document) };
}

/**
 * Everything the gate refuses about what the Cursor strip measured.
 *
 * An empty list is the only thing the gate may call green about that stage --
 * and unlike every other stage, the exit code is not even a second opinion.
 * Measured 2026-08-25 and then measured again: the first reading was a Cursor
 * test host that ran a failing suite and exited 0 where VS Code 1.134.0 exited 1
 * on the same file; over 33 launches that day the exit code turned out to
 * FLICKER, 1, 0, 0, 1 across four identical consecutive runs. Either way the
 * number a probe WROTE DOWN is the whole of the evidence, and this is what reads
 * it -- a flickering code is not a second opinion, it is a coin.
 *
 * **Both directions, and the second is the one that rots quietly.** A check
 * nothing admits is refused, because a probe measuring something the budget
 * never named is a number nobody chose to accept. A ceiling over a check
 * nothing measured is refused too, because a line about a probe that no longer
 * runs reads as coverage and is none -- the same rule
 * `verdictAgainstAllowances` holds for a point nothing judged.
 *
 * **The deadline is deliberately NOT here.** It is in `standingAllowances`,
 * which `allowance.test.ts` calls against the real file on every `npx jest`.
 * Repeating it here would print every expiry twice on a full gate.
 *
 * @param measured what the probe wrote down, one entry per check
 * @param document the budget as read from `gate/allowed-red.json`
 */
export function ratesAgainstBudget(
  measured: readonly RateMeasured[],
  document: AllowanceDocument
): readonly Refusal[] {
  const refusals: Refusal[] = [];
  const admitted = new Map(document.rates.map((one) => [one.check, one]));

  for (const came of measured) {
    const line = admitted.get(came.check);
    if (line === undefined) {
      refusals.push({
        point: null,
        because:
          `${came.check} missed ${String(came.misses)} of ${String(came.attempts)} and nothing in the budget ` +
          'names that check. A number nobody admitted is not a number the gate may pass.',
      });
      continue;
    }
    if (came.attempts < line.of) {
      refusals.push({
        point: null,
        because:
          `${came.check} was measured over ${String(came.attempts)} attempts and its ceiling was measured over ` +
          `${String(line.of)}. A rate over fewer attempts is not the same fact -- and a probe that quietly gave ` +
          'up looks exactly like this.',
      });
      continue;
    }
    if (came.misses > line.atMost) {
      refusals.push({
        point: null,
        because:
          `${came.check} missed ${String(came.misses)} of ${String(came.attempts)}, over the ` +
          `${String(line.atMost)} its line admits. What the line last saw: ${line.seen}`,
      });
    }
  }

  const answered = new Set(measured.map((one) => one.check));
  for (const line of document.rates) {
    if (!answered.has(line.check)) {
      refusals.push({
        point: null,
        because:
          `the budget bounds ${line.check} and nothing measured it. A ceiling over a check that no longer runs ` +
          'reads as coverage and is none.',
      });
    }
  }

  return refusals;
}

/**
 * Everything the gate refuses about this verdict, budget and day.
 *
 * An empty list is the only thing the gate may call green about the stand.
 */
export function verdictAgainstAllowances(
  verdict: Verdict,
  document: AllowanceDocument,
  today: string
): readonly Refusal[] {
  const refusals: Refusal[] = [...standingAllowances(document, today)];
  const admitted = new Map(document.allowances.map((one) => [one.point, one]));

  for (const found of verdict.findings) {
    const line = admitted.get(found.point);
    if (found.answer === 'green') {
      if (line !== undefined && !line.mayBeGreen) {
        refusals.push({
          point: found.point,
          because:
            `the budget admits point ${String(found.point)} and the stand says it is green now. ` +
            'Take the line out: an admission that outlives its defect is a permission nobody chose. ' +
            'If this point is INTERMITTENT rather than fixed, say so with `mayBeGreen` and put the runs in `seen`.',
        });
      }
      continue;
    }
    if (line === undefined) {
      refusals.push({
        point: found.point,
        because:
          `point ${String(found.point)} answered "${found.answer}" and nothing in the budget admits it: ${found.because}`,
      });
      continue;
    }
    if (line.answer !== found.answer) {
      refusals.push({
        point: found.point,
        because:
          `point ${String(found.point)} answered "${found.answer}", and its line admits "${line.answer}". ` +
          'An unmeasured point and a failed one are two different facts, and a line about one does not cover the other.',
      });
      continue;
    }
    const violations = found.violations ?? -1;
    if (violations > line.atMost) {
      refusals.push({
        point: found.point,
        because:
          `point ${String(found.point)} went wrong ${String(violations)} time(s), over the ` +
          `${String(line.atMost)} its line admits: ${found.because}`,
      });
    }
  }

  const judged = new Set(verdict.findings.map((one) => one.point));
  for (const line of document.allowances) {
    if (!judged.has(line.point)) {
      refusals.push({
        point: line.point,
        because:
          `the budget admits point ${String(line.point)} and this verdict says nothing about point ` +
          `${String(line.point)} at all. A line about a point nothing judges is a line nothing can retire.`,
      });
    }
  }

  return refusals;
}

/** Today, as the document spells a day. Taken from the caller so that a test can choose one. */
export function todayIs(clock: Date): string {
  return clock.toISOString().slice(0, 10);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is ${JSON.stringify(value)}, and it must be an object`);
  }
  return value as Record<string, unknown>;
}

function whatOf(document: Record<string, unknown>): readonly string[] {
  const what = document.what;
  return Array.isArray(what) ? what.map((line) => String(line)) : [];
}

/** One required sentence of a line, refused when it is missing or blank. */
function text_(line: Record<string, unknown>, key: string, what: string): string {
  const value = line[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${what} has no \`${key}\`, and every line says who admitted what and why`);
  }
  return value;
}

/**
 * The budget of the START, refused at the gate and admitted by nothing (Ш11).
 *
 * **Why it is not a line in `gate/allowed-red.json`.** That document is the
 * budget of ADMITTED REDNESS -- how much of the stand's own nine points a gate
 * will let through, unratified, with a date on it. A ceiling on how long a
 * window takes to start is not a redness anybody is admitting: it is a number
 * set from measurement, and a run over it is a run that has to be looked at. So
 * there is no line to write and no cap to spend, and the gate is red on it
 * directly.
 *
 * **`undefined` is refused, and that is the case worth the function.** The
 * stand writes the start's verdict into `verdict.json`; a gate reading a
 * verdict without one is reading a stand that never asked, and a question
 * nobody asked must never come out green (`judge.ts` says the same about
 * `unmeasured`, at more length).
 */
export function refusalForTheStart(start: StartVerdict | undefined): Refusal | null {
  if (start === undefined) {
    return {
      point: null,
      because:
        'this verdict says nothing about the start at all. A stand that did not time the start ' +
        'is not a stand that found it inside its budget -- see `tests/stand/start-budget.ts`.',
    };
  }
  if (start.answer === 'green') {
    return null;
  }
  return {
    point: null,
    because: `the start of a window answered "${start.answer}": ${start.because}`,
  };
}
