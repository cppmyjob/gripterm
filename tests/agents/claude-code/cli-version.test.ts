import {
  SUPPORTED_CLI_VERSION,
  describeCliVersion,
  isSupportedCliVersion,
  parseCliVersion,
} from '../../../packages/core/src/domain/agents/claude-code/cli-version';

describe('parseCliVersion', () => {
  it('reads the version out of the real --version output', () => {
    expect(parseCliVersion('2.1.225 (Claude Code)')).toBe('2.1.225');
  });

  it('tolerates leading whitespace', () => {
    expect(parseCliVersion('  2.1.226 (Claude Code)\n')).toBe('2.1.226');
  });

  it('returns undefined when the output carries no leading version', () => {
    expect(parseCliVersion('claude: command not found')).toBeUndefined();
  });
});

describe('isSupportedCliVersion', () => {
  it('accepts the pinned build', () => {
    expect(isSupportedCliVersion(`${SUPPORTED_CLI_VERSION} (Claude Code)`)).toBe(true);
  });

  it('rejects a neighbouring patch release', () => {
    expect(isSupportedCliVersion('2.1.226 (Claude Code)')).toBe(false);
  });

  it('rejects unparseable output rather than assuming a match', () => {
    expect(isSupportedCliVersion('')).toBe(false);
  });
});

describe('what to say about the build that will actually run', () => {
  it('is quiet, and says which build, when it is the pinned one', () => {
    const report = describeCliVersion({
      output: `${SUPPORTED_CLI_VERSION} (Claude Code)`,
      failure: null,
    });

    expect(report).toEqual({
      version: SUPPORTED_CLI_VERSION,
      level: 'info',
      message: expect.stringContaining(SUPPORTED_CLI_VERSION) as string,
    });
  });

  it('warns on a different build, naming both numbers', () => {
    // A warning and not a refusal: every fact this extension rests on was
    // measured against the pin, so a different build makes OUR claims doubtful
    // -- it does not make somebody's installation wrong.
    const report = describeCliVersion({ output: '2.1.227 (Claude Code)', failure: null });

    expect(report.level).toBe('warn');
    expect(report.version).toBe('2.1.227');
    expect(report.message).toContain('2.1.227');
    expect(report.message).toContain(SUPPORTED_CLI_VERSION);
  });

  it('does not claim a mismatch when the CLI would not answer', () => {
    const report = describeCliVersion({ output: null, failure: 'spawn ENOENT' });

    expect(report.version).toBeNull();
    expect(report.level).toBe('warn');
    expect(report.message).toContain('spawn ENOENT');
  });

  it('survives a failure that came with no words', () => {
    expect(describeCliVersion({ output: null, failure: null }).message).toContain('no answer');
  });

  it('does not claim a mismatch when the answer is not a version', () => {
    // Reporting "2.1.225 expected" against output we could not read would send
    // somebody to reinstall a CLI that is fine.
    const report = describeCliVersion({ output: 'Claude Code, latest', failure: null });

    expect(report.version).toBeNull();
    expect(report.level).toBe('warn');
    expect(report.message).toContain('Claude Code, latest');
  });
});
