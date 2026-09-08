/**
 * The Claude Code CLI build this extension's design was read out of. M1.14
 * compares the installed CLI with this pin and warns on a mismatch.
 *
 * This used to say "every fact in the design of this extension was measured
 * against" it, and that has stopped being true: facts measured against 2.1.233,
 * 2.1.245 and 2.1.260 are load-bearing here now, one of them in shipped
 * behaviour (`readSessionName` on `nameSource`). What is still true is the other
 * direction -- nothing in this design was read out of a build NEWER than the pin
 * without the site of it saying which build and what that says about the pin.
 * How far the pin has drifted, and what has and has not been re-measured since,
 * is `CLI_DRIFT` below.
 *
 * The comparison must be made against what actually runs. The CLI's own update
 * journal is not a substitute: it reported a successful 2.1.225 -> 2.1.226
 * upgrade twice while the launched binary stayed byte-identical to 2.1.225.
 */
export const SUPPORTED_CLI_VERSION = '2.1.225';

/**
 * How far the pin has drifted from the newest Claude Code this repository has
 * actually met.
 *
 * **The two numbers are not the same kind of thing, and equality between them is
 * not the invariant.** `SUPPORTED_CLI_VERSION` is a frozen claim about this
 * product: it stands in the README's requirements table, it is what
 * `describeCliVersion` warns a person against, and the owner decided on
 * 2026-09-08 not to raise it. The build stamp on a capture -- `build` in
 * `tests/agents/fixtures/roster-scene-2026-09-08.json` -- is provenance of a
 * recording, and its correctness condition is the opposite one: it MUST equal
 * the CLI that produced it, which `tests/integration/agent-listing.test.ts`
 * holds it to. One number is meant to stand still, the other is meant to move
 * with the machine, so they can agree only by coincidence and today they cannot
 * agree at all -- a CLI does not go backwards to 2.1.225.
 *
 * **What is an invariant is that the gap is not silent.** Between 2026-08-09,
 * when the pin was measured, and 2026-09-08 the installed CLI moved thirty-five
 * builds and nothing here said a word. The doc comment above still claims that
 * EVERY fact in this design was measured against the pin, and that claim is
 * already false: the rule `readSessionName` applies to `nameSource` was read off
 * 2.1.260 on 2026-09-08 and off nothing else. This record is what says both
 * things out loud, and `tests/agents/claude-code/cli-drift.test.ts` refuses it
 * when it goes stale -- by the calendar, not by anybody's memory.
 */
export interface CliDrift {
  /**
   * The pinned build, written out rather than read from the constant above: the
   * point is that this record names both numbers itself, and goes red the day
   * somebody raises the pin without rewriting it.
   */
  readonly pinned: string;
  /** The newest build this repository has met, and the capture it was met in. */
  readonly newest: string;
  readonly newestSeenIn: string;
  /** The day the newest build was met. */
  readonly metOn: string;
  /** What was put to the newest build and answered. Never empty. */
  readonly measured: readonly string[];
  /**
   * What was NOT put to it, and is therefore believed on the pin's word alone.
   * Never empty either: a record claiming the whole surface was re-measured
   * would be the defect this one exists against.
   */
  readonly notMeasured: readonly string[];
  /** Who decided the pin stays where it is, and what records that decision. */
  readonly decidedBy: string;
  /** The day this record stops working and the suite goes red. */
  readonly expires: string;
  /** How many times `expires` has been moved on this record, from 0. */
  readonly renewals: number;
  /** Why that many days, derived from a measurement rather than chosen. */
  readonly whyThatMany: string;
}

export const CLI_DRIFT: CliDrift = {
  pinned: '2.1.225',
  newest: '2.1.260',
  newestSeenIn: 'tests/agents/fixtures/roster-scene-2026-09-08.json',
  metOn: '2026-09-08',
  measured: [
    '`/rename` inside a real terminal. 2.1.260 KEEPS `nameSource` through a rename and writes `user` into it, where 2.1.228 REMOVED the key and its absence was the whole of the evidence a person had chosen the name. `readSessionName` was corrected to admit `user` on 2026-09-08, and the owner then typed `/rename test` into a real `claude` 2.1.260 under engine `own` and saw `test` arrive on the panel tab, on the list row and in the details header.',
    'The agent listing. The three session shapes of `tests/agents/fixtures/roster-scene-2026-09-08.json` -- one complete, one without `name` or `status`, one knowing neither its directory nor its start -- were planted into a private `CLAUDE_CONFIG_DIR`, read back out of 2.1.260, and still come back in the shape `parseAgentListing` reads.',
    '`--version`. 2.1.260 answers `2.1.260 (Claude Code)`, which `parseCliVersion` reads as a version.',
  ],
  notMeasured: [
    'Every fact read out of a BINARY rather than out of a run, and there are many: the ten notification literals and the `old_cwd` / `new_cwd` field names [2.1.225], the unconditional filtering of an http `SessionStart` registration [2.1.225], a hook `timeout` counted in SECONDS and the ten-minute default [2.1.224], the settings file locations and the directory rule [2.1.227 and 2.1.228], the exec form of a command hook [2.1.225]. None of them has been put to 2.1.260.',
    'What 2.1.260 writes for a session started with `claude --name X`. Measured against 2.1.228 on 2026-08-13 -- `name` present, `nameSource` absent -- and never since.',
    '`--resume` against a session the CLI has forgotten. Measured against 2.1.228 and again against 2.1.233 on 2026-08-20; not against 2.1.260.',
    'Two of the four acceptance criteria, П2 and О1, have never met ANY real CLI in this repository -- they are the two that spend an account. See `tests/acceptance/against-the-real-cli.json`.',
  ],
  decidedBy:
    'The owner, 2026-09-08: the pin is not to be raised. What records the decision is the Ш43 contract that relayed it and the queue line it closes; nothing in this repository carries that decision in the words of the owner.',
  expires: '2026-10-04',
  renewals: 0,
  whyThatMany:
    '26 days, and derived rather than rounded. One of the three behaviours this record vouches for has already been WATCHED changing meaning here: `nameSource` on `/rename` was measured on 2026-08-13 against 2.1.228, where the key was removed, and on 2026-09-08 against 2.1.260, where it is kept and carries `user`. 26 days lie between those two measurements, and the change that happened inside them cost this build a defect that refused every name the real CLI gave. So a record vouching for that behaviour may not outlive one such interval: at the end of it, a change of exactly the size already seen could have happened again and nothing here would know. Longer would make this decorative. The number is not round on purpose -- a round one would say it came from a preference.',
};

const VERSION_PREFIX = /^\s*(\d+\.\d+\.\d+)/;

/**
 * Extracts the version from `claude --version` output, which is shaped like
 * "2.1.225 (Claude Code)". Returns undefined when the output carries no
 * leading version, so that a changed output format degrades into a warning
 * rather than into a wrong comparison.
 */
export function parseCliVersion(output: string): string | undefined {
  const match = VERSION_PREFIX.exec(output);
  return match?.[1];
}

/**
 * True when the installed CLI is exactly the pinned build. Deliberately strict:
 * a patch release can move any of the measured behaviours, and the point of the
 * check is to notice that, not to tolerate it.
 */
export function isSupportedCliVersion(output: string): boolean {
  return parseCliVersion(output) === SUPPORTED_CLI_VERSION;
}

/** What `<claude> --version` answered: its output, or why there is none. */
export interface CliVersionAnswer {
  readonly output: string | null;
  readonly failure: string | null;
}

export interface CliVersionReport {
  readonly version: string | null;
  /** `info` when the installed build is the pinned one, `warn` otherwise. */
  readonly level: 'info' | 'warn';
  readonly message: string;
}

/**
 * What to say about the CLI this machine will actually run.
 *
 * Four answers rather than a boolean, because the four are acted on
 * differently by the person reading them: the same build, a different build, a
 * build that would not say, and a build whose answer we could not read. The
 * last two are NOT reported as a mismatch -- claiming a version difference we
 * did not establish would send somebody to reinstall something that is fine.
 *
 * A warning and never a refusal. Every fact this extension rests on was
 * measured against the pin, so a different build is a reason to distrust our
 * facts -- not a reason to stop a person from using their own installation.
 */
export function describeCliVersion(answer: CliVersionAnswer): CliVersionReport {
  if (answer.output === null) {
    return {
      version: null,
      level: 'warn',
      message: `could not ask Claude Code which version it is: ${answer.failure ?? 'no answer'}`,
    };
  }

  const version = parseCliVersion(answer.output);
  if (version === undefined) {
    return {
      version: null,
      level: 'warn',
      message: `Claude Code answered "${answer.output}", which this build cannot read as a version`,
    };
  }
  if (version === SUPPORTED_CLI_VERSION) {
    return { version, level: 'info', message: `Claude Code ${version}, the build this was measured against` };
  }
  return {
    version,
    level: 'warn',
    message: `Claude Code ${version} is installed; this build was measured against ${SUPPORTED_CLI_VERSION}. Everything should still work, and anything that does not is worth reporting with both numbers`,
  };
}
