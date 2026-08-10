import {
  SUPPORTED_CLI_VERSION,
  isSupportedCliVersion,
  parseCliVersion,
} from '../../packages/core/src/domain/services/cli-version.js';

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
