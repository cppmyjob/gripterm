import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A run that can bring an agent up SAYS whose agent it is, and a run that keeps
 * the real one says where the real one writes.
 *
 * **The defect this exists for, found 2026-08-31.** Ш32 gave the acceptance a
 * double and took the real `claude` off its default path. Nothing did the same
 * for the four other runs of this repository that press
 * `gripterm.newTerminal` -- and every one of them therefore started a real CLI
 * in the profile of whoever ran it, because `CLAUDE_CONFIG_DIR` is what MOVES
 * that profile and none of them set it. Two of these were already written down
 * as open questions -- "every stand run lays 8 new conversations in the default
 * CLI profile", "the stand starts `claude` in the default CLI profile: 24
 * launches over three runs" -- and the packaging run had the same hole with
 * nothing said about it at all. It cost the owner conversations in his own
 * store, one per terminal, on every run of a green gate.
 *
 * **What is asserted, and it is deliberately not "nobody starts a real one".**
 * Some of these runs NEED a real CLI: the suites in `.vscode-test.mjs` whose
 * subject IS the CLI cannot be pointed at a double at all. So the rule is about
 * SILENCE rather than about the CLI. Each run answers in one of two ways:
 *
 *   1. it DEFAULTS to the double of `tests/acceptance/fake-claude/` -- the
 *      double built and put in front of the real CLI on PATH, its records moved
 *      out of the person's profile by `CLAUDE_CONFIG_DIR`, and the run's own
 *      switch falling back to it when nobody chose; or
 *   2. it declares, in its own text, that it starts a real agent in the default
 *      profile, why it has to, where that profile is, and what would lift it.
 *
 * Saying nothing is the failure. The two answers are not ranked: which one a run
 * should give is a judgement about that run and about what its green is worth,
 * and this file only refuses to let a run avoid making it. The judgement can go
 * either way and has: on 2026-08-31 the packaging run was moved to the double
 * and then moved BACK the same day, by the owner, once the exchange was laid out
 * -- it is the one run where a real CLI meets a real installed archive, it costs
 * one empty conversation, and it is started by hand and never by a gate. This
 * file was green before that reversal and after it, which is the shape it is
 * meant to have: it is not an argument for the double, it is a refusal of
 * silence.
 *
 * **Which runs are listed, and why exactly these.** Every run of ours that can
 * reach `gripterm.newTerminal` or `lifecycle.launch` and therefore start
 * whatever `claude` resolves to on PATH. That is the criterion, and it is
 * narrower than "every run": `tests/cursor` is not here because nothing under it
 * exercises Gripterm -- it measures the fork's own workbench -- and it lives
 * inside `.vscode-test.mjs`, which is listed once as the file it is. `tests/eyes`
 * and `tests/stand` are here although neither has an agent as its SUBJECT:
 * subject is not the question, starting one is.
 *
 * **Read as TEXT, and the same crudeness the sibling guard accepts.** No import,
 * for the reason `every-run-names-its-engine.test.ts` gives at length: importing
 * a runner runs it. What is checked is the shape of a line, which is crude in
 * the safe direction -- a run that moved the profile some other way is not seen
 * here and would fail this, and a line seen here is really written.
 *
 * **What this does NOT promise, and it is the larger half.**
 *
 *   * That the line is REACHED. Both runs with a switch set `CLAUDE_CONFIG_DIR`
 *     only in their `fake` mode and leave it unset under `...AGENT=real`
 *     deliberately, because a real CLI has to run in the profile its person is
 *     logged into. This file reads the assignment and the FALLBACK, and cannot
 *     tell which branch a given run took on a given day. A real agent reached by
 *     name is a person's choice, made out loud, and none of this is about that.
 *   * That a declaration is TRUE. Answer 2 is a sentence, and a sentence is only
 *     worth the person who wrote it. What it buys is that the sentence exists
 *     where the run is, so the next reader of that runner learns the price
 *     before paying it instead of after.
 */

const REPO = join(__dirname, '..');

/** The double, put in front of the real CLI on PATH. `tests/acceptance/fake-claude/build.mjs` is what makes it. */
const PUTS_THE_DOUBLE_ON_THE_PATH = /buildFakeClaude\s*\(/u;

/**
 * A run's own agent switch, and WHICH AGENT IT FALLS BACK TO when nobody chose.
 *
 * This is the reader the whole file turns on, and it was not in the first
 * writing of it. That was a defect rather than a simplification, and it was
 * caught the same day by the thing it would have excused: for one revision on
 * 2026-08-31 `tests/vsix/run.mjs` carried every line of the double's machinery
 * -- `buildFakeClaude`, the PATH, the moved profile -- and DEFAULTED to a real
 * `claude` all the same. A guard that reads the MACHINERY passes that run. A
 * guard that reads the DEFAULT does not, and the default is the only thing a
 * person who types `pnpm test:vsix` ever gets.
 */
const FALLS_BACK_TO = /_AGENT\s*\?\?\s*'(\w+)'/u;

/**
 * The CLI's whole user level, moved into a directory of the run's own.
 *
 * An ASSIGNMENT and not the name: every file listed below is free to mention
 * `CLAUDE_CONFIG_DIR` in prose, and a run that only talked about moving the
 * profile would otherwise count as one that moved it.
 */
const MOVES_THE_PROFILE = /process\.env\.CLAUDE_CONFIG_DIR\s*=[^=]/u;

/**
 * The declaration a run makes instead, when it keeps a real agent in the
 * person's own profile.
 *
 * A plain string, and looked for as one: there is nothing in it a regular
 * expression would add, and `reasonIn` below reads the paragraph under it by
 * lines rather than by a pattern -- a pattern that could cross a blank comment
 * line and stop at the right one turned out to be a pattern the linter refuses
 * for backtracking, and it was harder to read besides.
 */
const MARKER = 'A REAL AGENT IN THE DEFAULT PROFILE, AND WHY:';

/** The comment gutter, off the front of one line of a declaration. */
const GUTTER = /^[ \t]*\*[ \t]?/u;

/** Lines, however the file ends them. */
const NEWLINE = /\r?\n/u;

/**
 * Where the CLI writes when nothing moved it, named literally.
 *
 * `settings-locations.ts` states the rule this spells: `CLAUDE_CONFIG_DIR` if it
 * is set, `~/.claude` otherwise. A declaration that skipped this would say a run
 * costs something without saying what pays.
 */
const WHERE_IT_WRITES = '~/.claude';

/**
 * How much of a reason counts as one: about two lines of prose.
 *
 * A number, and therefore arbitrary -- what it really refuses is the one-clause
 * reason, "because it needs one", which is the marker restated. It cannot refuse
 * a bad paragraph, and does not pretend to.
 */
const REASON_AT_LEAST = 80;

interface Run {
  /** How the run is spoken about. */
  readonly what: string;
  /** Where it is, relative to the repository. */
  readonly file: string;
  /** How this run can start an agent at all -- the reason it is on this list. */
  readonly starts: string;
}

/**
 * Every run of ours that can put a `claude` on a pty, and how each one gets there.
 *
 * `.vscode-test.mjs` is one entry although it declares three labels: it is one
 * file, a person runs it by label, and the suites that start a real CLI say so
 * in their own words (`closing-a-terminal.test.ts`, `orphan-processes.test.ts`,
 * `pty-engine.test.ts` -- "this test is about a real one").
 */
const RUNS: readonly Run[] = [
  {
    what: 'the integration and own labels',
    file: '.vscode-test.mjs',
    starts: 'suites under tests/integration call lifecycle.launch on readiness.cliPath',
  },
  {
    what: 'the stand',
    file: join('tests', 'stand', 'run.mjs'),
    starts: 'tests/stand/observer/extension.js presses gripterm.newTerminal, twice a sitting',
  },
  {
    what: 'the eyes',
    file: join('tests', 'eyes', 'run.mjs'),
    starts: 'tests/eyes/observer/extension.js presses gripterm.newTerminal to build its scenes',
  },
  {
    what: 'the acceptance run',
    file: join('tests', 'acceptance', 'run.mjs'),
    starts: 'its suites open terminals through the product, and GRIPTERM_ACCEPTANCE_AGENT=real is reachable by name',
  },
  {
    what: 'the packaging run',
    file: join('tests', 'vsix', 'run.mjs'),
    starts: 'the check `the button a person presses brings a terminal up` runs gripterm.newTerminal',
  },
];

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/**
 * The paragraph of reason under a declaration's marker, as one line of prose.
 *
 * Read by lines rather than matched: the paragraph begins under the marker,
 * after the blank comment line a person leaves there, and ends at the next blank
 * one or at the end of the comment. Everything before the first word is skipped
 * and everything after the paragraph is not this declaration's business.
 */
function reasonIn(text: string): string {
  const at = text.indexOf(MARKER);
  if (at < 0) {
    return '';
  }
  const paragraph: string[] = [];
  for (const raw of text.slice(at + MARKER.length).split(NEWLINE)) {
    if (raw.includes('*/')) {
      break;
    }
    const line = raw.replace(GUTTER, '').trim();
    if (line === '') {
      // A blank line before the first word is the layout; one after it is the end.
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }
  return paragraph.join(' ');
}

/** Which agent a run gets when nobody named one, or null when it has no switch at all. */
function defaultAgentOf(text: string): string | null {
  return FALLS_BACK_TO.exec(text)?.[1] ?? null;
}

/**
 * The two answers, and why they are two rather than the three a reader might
 * expect from the list at the head of this file.
 *
 * "Moves `CLAUDE_CONFIG_DIR`" is not an answer on its own and cannot be. Moving
 * that variable hands the run a profile with no account logged into it, so it is
 * only ever HALF of the first answer -- the half that keeps the double's records
 * out of a person's own store. A run that moved it and still started a real CLI
 * would have bought nothing and broken the CLI. Both halves are therefore
 * required together, with the default, or the run declares.
 */
const ANSWERS = [
  {
    name: 'the double by default',
    given: (text: string) =>
      defaultAgentOf(text) === 'fake'
      && PUTS_THE_DOUBLE_ON_THE_PATH.test(text)
      && MOVES_THE_PROFILE.test(text),
  },
  { name: 'a declaration', given: (text: string) => text.includes(MARKER) },
] as const;

/**
 * Every answer a run gives, and not the first one it gives.
 *
 * A run is free to give both: one that defaults to the double and still keeps a
 * `real` mode reachable by name has something worth declaring about that mode.
 */
function answersOf(file: string): readonly string[] {
  const text = textOf(file);
  return ANSWERS.filter(({ given }) => given(text)).map(({ name }) => name);
}

describe('a run that can bring an agent up', () => {
  it('says whose agent it starts, instead of silently starting a real one wherever the CLI defaults to', () => {
    const silent = RUNS.filter(({ file }) => answersOf(file).length === 0).map(
      ({ what, file, starts }) =>
        `${what} (${file}) says nothing about whose \`claude\` it starts, and it starts one: ${starts}`
    );

    expect(silent).toStrictEqual([]);
  });

  it('says where a real one writes, when a declaration is among the answers it gives', () => {
    const vague = RUNS.filter(({ file }) => answersOf(file).includes('a declaration')).flatMap(({ what, file }) => {
      const text = textOf(file);
      const reason = reasonIn(text);
      const missing: string[] = [];
      if (reason.length < REASON_AT_LEAST) {
        missing.push(`gives ${String(reason.length)} characters of reason, and ${String(REASON_AT_LEAST)} is the least this counts as one`);
      }
      if (!text.includes(WHERE_IT_WRITES)) {
        missing.push(`never names ${WHERE_IT_WRITES}, which is where the CLI writes when nothing moved it`);
      }
      return missing.map((said) => `${what} (${file}) ${said}`);
    });

    expect(vague).toStrictEqual([]);
  });

  it('is on a list of files that are all there, so that a rename cannot empty this', () => {
    const gone = RUNS.filter(({ file }) => !existsSync(join(REPO, file))).map(({ file }) => file);

    expect(gone).toStrictEqual([]);
  });

  /*
   * That the three readers above see anything at all. Without this, a regular
   * expression that matched nothing would leave the first assertion red for
   * every run at once and the second green over an empty list -- the way a guard
   * stops guarding, which this repository has been bitten by three times
   * (`named-tests-exist.test.ts`, `every-label-is-run.test.ts` and
   * `every-run-names-its-engine.test.ts` all carry a line like this).
   */
  it('is looked for with readers that find something, so that no assertion above is about an empty list', () => {
    const given = new Set(RUNS.flatMap(({ file }) => answersOf(file)));
    const blind = ANSWERS.filter(({ name }) => !given.has(name)).map(
      ({ name }) => `no run in this list answers with ${name}, so that reader is finding nothing anywhere`
    );

    expect(RUNS).toHaveLength(5);
    expect(blind).toStrictEqual([]);
  });
});
