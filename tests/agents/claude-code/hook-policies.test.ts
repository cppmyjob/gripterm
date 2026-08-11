import { reviewHookPolicies } from '../../../packages/core/src/domain/agents/claude-code/hook-policies';
import type { ClaudeSettingsSource } from '../../../packages/core/src/domain/agents/claude-code/hook-policies';

const URL_PREFIX = 'http://127.0.0.1:51422/ev/';

function review(...sources: readonly ClaudeSettingsSource[]): readonly string[] {
  return reviewHookPolicies(sources, { urlPrefix: URL_PREFIX }).map((finding) => finding.setting);
}

describe('the settings that can silence every hook we register', () => {
  it('says nothing at all when nothing is set', () => {
    expect(review({ path: '/etc/claude-code/managed-settings.json', settings: {} })).toEqual([]);
  });

  it('says nothing when there is no settings file anywhere', () => {
    expect(review()).toEqual([]);
  });

  it('reports hooks switched off wholesale', () => {
    expect(review({ path: '/home/p/.claude/settings.json', settings: { disableAllHooks: true } }))
      .toEqual(['disableAllHooks']);
  });

  it('reports the administrator policy that no setting of ours can outvote', () => {
    expect(review({ path: '/etc/claude-code/managed-settings.json', settings: { allowManagedHooksOnly: true } }))
      .toEqual(['allowManagedHooksOnly']);
  });

  it('leaves a switch that is off alone', () => {
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { disableAllHooks: false, allowManagedHooksOnly: false },
      })
    ).toEqual([]);
  });

  it('reports an env var allow-list that leaves our token out', () => {
    // The consequence is specific and worth naming: the header goes out as
    // `Bearer ` and every event answers 401 on a file that reads correctly.
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { httpHookAllowedEnvVars: ['SOMETHING_ELSE'] },
      })
    ).toEqual(['httpHookAllowedEnvVars']);
  });

  it('is quiet about an env var allow-list that lets our token through', () => {
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { httpHookAllowedEnvVars: ['GRIPTERM_TOKEN', 'PATH'] },
      })
    ).toEqual([]);
  });

  it('reports a url allow-list whatever it contains', () => {
    // We do not evaluate it. The port is drawn fresh at every activation and the
    // pattern language is the CLI's, so an allow-list that happens to match
    // today is not something this can promise about tomorrow. Presence is the
    // fact; the person reads the pattern.
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { allowedHttpHookUrls: ['http://127.0.0.1:*/ev/*'] },
      })
    ).toEqual(['allowedHttpHookUrls']);
  });

  it('carries the url it is talking about into the finding', () => {
    const [finding] = reviewHookPolicies(
      [{ path: '/home/p/.claude/settings.json', settings: { allowedHttpHookUrls: [] } }],
      { urlPrefix: URL_PREFIX }
    );

    expect(finding?.message).toContain(URL_PREFIX);
  });

  it('names the file each finding came from, because that is where it gets fixed', () => {
    const findings = reviewHookPolicies(
      [
        { path: '/etc/claude-code/managed-settings.json', settings: { allowManagedHooksOnly: true } },
        { path: '/home/p/.claude/settings.json', settings: { disableAllHooks: true } },
      ],
      { urlPrefix: URL_PREFIX }
    );

    expect(findings.map((finding) => finding.path)).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/home/p/.claude/settings.json',
    ]);
  });

  it('reports every policy in one file rather than the first', () => {
    expect(
      review({
        path: '/etc/claude-code/managed-settings.json',
        settings: { disableAllHooks: true, allowedHttpHookUrls: ['x'] },
      })
    ).toEqual(['disableAllHooks', 'allowedHttpHookUrls']);
  });

  it('ignores a value whose shape is not the one the setting takes', () => {
    // A malformed file is the CLI's to refuse. Guessing at `"true"` here would
    // be this report inventing a policy the CLI never applied.
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { disableAllHooks: 'true', httpHookAllowedEnvVars: 'GRIPTERM_TOKEN' },
      })
    ).toEqual([]);
  });

  it('ignores a list whose items are not names either', () => {
    // The same rule as the boolean above, and it has to be the same rule: a
    // value the CLI refuses is a policy that is NOT in force, and reporting one
    // would send somebody to fix a setting that is already doing nothing. What
    // catches a blocker we stayed silent about is the observability watch, not
    // a guess made here (§4.7).
    expect(
      review({
        path: '/home/p/.claude/settings.json',
        settings: { httpHookAllowedEnvVars: [1, 2], allowedHttpHookUrls: [{}] },
      })
    ).toEqual([]);
  });

  it('survives a settings file that is not an object at all', () => {
    // Total over what the signature accepts, which is `unknown`. The reader can
    // only ever produce what `JSON.parse` returned -- but the type says more
    // than the reader does, and a function that throws on a value its own
    // signature admits is a trap for the next caller.
    expect(review({ path: '/home/p/.claude/settings.json', settings: null })).toEqual([]);
    expect(review({ path: '/home/p/.claude/settings.json', settings: undefined })).toEqual([]);
    expect(review({ path: '/home/p/.claude/settings.json', settings: ['a'] })).toEqual([]);
    expect(review({ path: '/home/p/.claude/settings.json', settings: 7 })).toEqual([]);
  });
});
