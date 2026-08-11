import { TOKEN_ENV_VAR } from './session-settings-builder';

/** One settings file, as read: its path, and whatever JSON was in it. */
export interface ClaudeSettingsSource {
  readonly path: string;
  readonly settings: unknown;
}

export interface HookPolicyFinding {
  /** The file to change. A finding without it is a puzzle rather than a report. */
  readonly path: string;
  readonly setting: string;
  readonly message: string;
}

export interface HookPolicyContext {
  /** Everything before the terminal id in the URL the hooks post to. */
  readonly urlPrefix: string;
}

interface PolicyCheck {
  readonly setting: string;
  readonly review: (value: unknown, context: HookPolicyContext) => string | null;
}

/**
 * The four settings that can leave every hook we register unfired, in the order
 * they are reported.
 *
 * Each returns a sentence or `null`, and the sentence names the CONSEQUENCE
 * rather than the setting: somebody reads this line because a terminal sat
 * silent, and "allowManagedHooksOnly is true" does not tell them why.
 */
const CHECKS: readonly PolicyCheck[] = [
  {
    setting: 'disableAllHooks',
    review: (value) =>
      asBoolean(value) === true
        ? 'every hook is switched off here, so no terminal can be observed while it is set'
        : null,
  },
  {
    setting: 'allowManagedHooksOnly',
    review: (value) =>
      asBoolean(value) === true
        ? 'only hooks from managed settings run. Gripterm registers its own through --settings, which this policy blocks, and no setting of ours can outvote it'
        : null,
  },
  {
    setting: 'httpHookAllowedEnvVars',
    review: (value) => {
      const allowed = asStringArray(value);
      if (allowed === null || allowed.includes(TOKEN_ENV_VAR)) {
        return null;
      }
      return `${TOKEN_ENV_VAR} is not in this list, so the hook's Authorization header goes out empty and every event is answered 401`;
    },
  },
  {
    setting: 'allowedHttpHookUrls',
    // Reported on PRESENCE, not on a verdict. The port is drawn fresh at every
    // activation, so a list that matches today says nothing about tomorrow --
    // and the pattern language belongs to the CLI. Evaluating it here would be
    // this report guessing at somebody else's matcher and then being trusted.
    review: (value, context) =>
      asStringArray(value) === null
        ? null
        : `hook urls are filtered by this list. Gripterm posts to ${context.urlPrefix}<terminal id>, on a port drawn afresh at every activation -- if the list does not admit it, no event arrives and nothing else says so`,
  },
];

/**
 * What the settings on this machine say about our hooks.
 *
 * An explanation and not a detector, which is the correction §4.7 records: a
 * check that reads settings can only ever cover the causes it was told about,
 * while "the terminal has been running for N seconds and has sent nothing" (the
 * observability watch) covers a policy, a version change, a broken file and our
 * own mistake at once. This runs so that a silence already noticed has a
 * candidate reason attached, in the same log, at the same moment.
 */
export function reviewHookPolicies(
  sources: readonly ClaudeSettingsSource[],
  context: HookPolicyContext
): readonly HookPolicyFinding[] {
  const findings: HookPolicyFinding[] = [];

  for (const source of sources) {
    const settings = asRecord(source.settings);
    if (settings === null) {
      continue;
    }
    for (const check of CHECKS) {
      const message = check.review(settings[check.setting], context);
      if (message !== null) {
        findings.push({ path: source.path, setting: check.setting, message });
      }
    }
  }

  return findings;
}

/**
 * An object to look settings up in, or `null`.
 *
 * An array needs no special case, and that is measured rather than assumed: a
 * mutation admitting arrays here survived the whole suite, because a JSON array
 * cannot carry a named key -- so every lookup below finds `undefined` and no
 * finding is produced either way. The guard was removed rather than paired with
 * a test asserting something that cannot happen.
 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * `null` for anything that is not a boolean.
 *
 * A file with `"true"` in it is a file the CLI refuses, and reporting a policy
 * the CLI never applied would send somebody to fix the wrong thing.
 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}
