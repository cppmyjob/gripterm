import { posix, win32 } from 'node:path';

const WINDOWS = 'win32';
const MACOS = 'darwin';

/**
 * Where an administrator's settings live, by platform.
 *
 * Read out of the binary 2.1.227 rather than out of the documentation, because
 * the documentation names the file and not the directory:
 *
 *   `function MUg(){switch(Yt()){case"macos":return"/Library/Application
 *    Support/ClaudeCode";case"windows":return"C:\\Program Files\\ClaudeCode";
 *    default:return"/etc/claude-code"}}`
 *
 * and `getDropInDir(){return this.dropInDir??=join(Kz(),"managed-settings.d")}`.
 */
const MANAGED_DIRECTORIES: Readonly<Record<string, string>> = {
  [WINDOWS]: 'C:\\Program Files\\ClaudeCode',
  [MACOS]: '/Library/Application Support/ClaudeCode',
};

const MANAGED_FALLBACK = '/etc/claude-code';
const MANAGED_FILE = 'managed-settings.json';
const DROP_IN_DIRECTORY = 'managed-settings.d';

const USER_DIRECTORY = '.claude';
const PROJECT_DIRECTORY = '.claude';
const SETTINGS_FILE = 'settings.json';
const LOCAL_SETTINGS_FILE = 'settings.local.json';

export interface SettingsLocationFacts {
  /** `process.platform`. It decides where an administrator's file lives, and nothing else. */
  readonly platform: string;
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR`, which MOVES the user level rather than adding to it. */
  readonly configDir: string | undefined;
  /** The folders of this window, each of which may carry a project and a local file. */
  readonly folders: readonly string[];
}

export interface SettingsLocations {
  readonly files: readonly string[];
  /** Directories whose `*.json` files are settings too. Listed by the reader, not here. */
  readonly directories: readonly string[];
}

/**
 * Every file that can carry a setting able to silence our hooks.
 *
 * This is a REPORT's input and not a merge: nothing here reproduces how the CLI
 * combines these levels, because a second implementation of somebody else's
 * precedence is a thing that drifts and then lies. What the caller does with
 * them is say what it found and where (§4.7: the policy read explains a silence
 * that was noticed by behaviour, it does not detect one).
 *
 * NOT COVERED, and said here rather than discovered: the Windows registry
 * policy keys `HKLM\SOFTWARE\Policies\ClaudeCode` and the HKCU counterpart are
 * read by the CLI [binary 2.1.227] and are not read here. They need a process
 * launch to interrogate, and a policy set that way is set by somebody who is
 * not the person reading our log.
 */
export function claudeSettingsLocations(facts: SettingsLocationFacts): SettingsLocations {
  const path = facts.platform === WINDOWS ? win32 : posix;
  const managed = MANAGED_DIRECTORIES[facts.platform] ?? MANAGED_FALLBACK;

  const files = [
    // First, because it is the one level nothing below can outvote.
    path.join(managed, MANAGED_FILE),
    path.join(facts.configDir ?? path.join(facts.home, USER_DIRECTORY), SETTINGS_FILE),
    ...facts.folders.flatMap((folder) => [
      path.join(folder, PROJECT_DIRECTORY, SETTINGS_FILE),
      path.join(folder, PROJECT_DIRECTORY, LOCAL_SETTINGS_FILE),
    ]),
  ];

  return {
    // A multi-root workspace may hold the same folder twice, and a file read
    // twice is a finding reported twice.
    files: [...new Set(files)],
    directories: [path.join(managed, DROP_IN_DIRECTORY)],
  };
}
