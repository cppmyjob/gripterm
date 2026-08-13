import {
  claudeSessionsDirectory,
  claudeSettingsLocations,
  claudeTranscriptsDirectory,
  claudeUserDirectory,
} from '../../../packages/core/src/domain/agents/claude-code/settings-locations';

describe('where Claude Code keeps the settings that can block a hook', () => {
  it('names the managed file and its drop-in directory on windows', () => {
    const found = claudeSettingsLocations({
      platform: 'win32',
      home: 'C:\\Users\\person',
      configDir: undefined,
      folders: [],
    });

    // Measured from the binary 2.1.227, not guessed: `MUg()` answers
    // "C:\\Program Files\\ClaudeCode" for windows, and the drop-in directory is
    // that path joined with "managed-settings.d".
    expect(found.files).toContain('C:\\Program Files\\ClaudeCode\\managed-settings.json');
    expect(found.directories).toContain('C:\\Program Files\\ClaudeCode\\managed-settings.d');
  });

  it('names the managed file on macos and on everything else', () => {
    const mac = claudeSettingsLocations({
      platform: 'darwin',
      home: '/Users/person',
      configDir: undefined,
      folders: [],
    });
    const other = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: undefined,
      folders: [],
    });

    expect(mac.files).toContain('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(other.files).toContain('/etc/claude-code/managed-settings.json');
  });

  it('reads the user level from the home directory', () => {
    const found = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: undefined,
      folders: [],
    });

    expect(found.files).toContain('/home/person/.claude/settings.json');
  });

  it('lets CLAUDE_CONFIG_DIR move the user level, because it moves it for the CLI too', () => {
    // The M0 runs were isolated with exactly this variable. A report that read
    // the home directory while the CLI read somewhere else would explain the
    // wrong machine's silence.
    const found = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: '/tmp/probe-config',
      folders: [],
    });

    expect(found.files).toContain('/tmp/probe-config/settings.json');
    expect(found.files).not.toContain('/home/person/.claude/settings.json');
  });

  it('reads both project levels, for every folder of the window', () => {
    const found = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: undefined,
      folders: ['/work/one', '/work/two'],
    });

    expect(found.files).toContain('/work/one/.claude/settings.json');
    expect(found.files).toContain('/work/one/.claude/settings.local.json');
    expect(found.files).toContain('/work/two/.claude/settings.json');
    expect(found.files).toContain('/work/two/.claude/settings.local.json');
  });

  it('puts the managed level first, because that is the one nobody here can override', () => {
    const found = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: undefined,
      folders: ['/work/one'],
    });

    expect(found.files[0]).toBe('/etc/claude-code/managed-settings.json');
  });

  it('never repeats a file when the same folder is open twice', () => {
    const found = claudeSettingsLocations({
      platform: 'linux',
      home: '/home/person',
      configDir: undefined,
      folders: ['/work/one', '/work/one'],
    });

    expect(new Set(found.files).size).toBe(found.files.length);
  });
});

describe('where Claude Code keeps the conversations', () => {
  it('hangs the transcripts off the user level, in the platform\'s spelling', () => {
    // Read out of the binary 2.1.228: `function vA(){return
    // u$.join(wn(),"projects")}`, and `wn()` is the user level.
    expect(
      claudeTranscriptsDirectory({ platform: 'win32', home: 'C:\\Users\\person', configDir: undefined })
    ).toBe('C:\\Users\\person\\.claude\\projects');
    expect(
      claudeTranscriptsDirectory({ platform: 'linux', home: '/home/person', configDir: undefined })
    ).toBe('/home/person/.claude/projects');
  });

  it('follows CLAUDE_CONFIG_DIR, which is what keeps an experiment off a real profile', () => {
    expect(
      claudeTranscriptsDirectory({
        platform: 'linux',
        home: '/home/person',
        configDir: '/tmp/probe-config',
      })
    ).toBe('/tmp/probe-config/projects');
  });

  it('hangs the running sessions off the user level too', () => {
    // One file per live process, named after its pid, and the only place the
    // CLI writes the name a person gave with `/rename` (measured 2026-08-13).
    expect(
      claudeSessionsDirectory({ platform: 'win32', home: 'C:\\Users\\person', configDir: undefined })
    ).toBe('C:\\Users\\person\\.claude\\sessions');
    expect(
      claudeSessionsDirectory({ platform: 'linux', home: '/home/person', configDir: '/tmp/probe-config' })
    ).toBe('/tmp/probe-config/sessions');
  });

  it('answers the user level on its own, because more than one thing hangs off it', () => {
    expect(
      claudeUserDirectory({ platform: 'linux', home: '/home/person', configDir: undefined })
    ).toBe('/home/person/.claude');
  });
});
