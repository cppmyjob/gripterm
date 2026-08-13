import { posix, win32 } from 'node:path';
import type { PlatformPath } from 'node:path';

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
const TRANSCRIPTS_DIRECTORY = 'projects';
const SESSIONS_DIRECTORY = 'sessions';

/** Enough to find the user level, which is what everything of the CLI's hangs off. */
export interface ClaudeUserFacts {
  /** `process.platform`. It decides where an administrator's file lives, and nothing else. */
  readonly platform: string;
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR`, which MOVES the user level rather than adding to it. */
  readonly configDir: string | undefined;
}

export interface SettingsLocationFacts extends ClaudeUserFacts {
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
  const path = pathFor(facts.platform);
  const managed = MANAGED_DIRECTORIES[facts.platform] ?? MANAGED_FALLBACK;

  const files = [
    // First, because it is the one level nothing below can outvote.
    path.join(managed, MANAGED_FILE),
    path.join(claudeUserDirectory(facts), SETTINGS_FILE),
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

/** `CLAUDE_CONFIG_DIR` if it is set, `~/.claude` otherwise. */
export function claudeUserDirectory(facts: ClaudeUserFacts): string {
  return facts.configDir ?? pathFor(facts.platform).join(facts.home, USER_DIRECTORY);
}

/**
 * Where conversation transcripts live.
 *
 * Read out of the binary 2.1.228 rather than assumed, the same way the managed
 * directory above was:
 *
 *   `function vA(){return u$.join(wn(),"projects")}`
 *
 * and `wn()` is the user level -- `join(process.env.CLAUDE_CONFIG_DIR ??
 * join(homedir(),".claude"))`, which is why an experiment that sets
 * `CLAUDE_CONFIG_DIR` keeps off a person's real transcripts as well as their
 * real settings.
 *
 * What is NOT reproduced here is the name of the directory INSIDE it. The CLI
 * builds it from the working directory as `e.replace(/[^a-zA-Z0-9]/g,"-")`, and
 * when that exceeds 200 characters it truncates and appends a hash of the
 * original [binary 2.1.228: `function ypo(e){...}`, `Dee=200`]. Reproducing a
 * rule with a hash in it is how a second implementation starts lying, so the
 * reader below scans the directories instead and matches on the file NAME,
 * which is the session id (A25).
 */
export function claudeTranscriptsDirectory(facts: ClaudeUserFacts): string {
  return pathFor(facts.platform).join(claudeUserDirectory(facts), TRANSCRIPTS_DIRECTORY);
}

/**
 * Where the CLI says what it is running right now: one file per live process,
 * named after its pid.
 *
 * A22 refused this directory as a source of SESSIONS -- it is written late, it
 * survives a killed process, and its field set moves between builds. What it is
 * used for (M2.17) is the one field nothing else carries: the name a person gave
 * a conversation with `/rename`, which `claude agents --json` reports without
 * saying whether the CLI or a person chose it.
 */
export function claudeSessionsDirectory(facts: ClaudeUserFacts): string {
  return pathFor(facts.platform).join(claudeUserDirectory(facts), SESSIONS_DIRECTORY);
}

function pathFor(platform: string): PlatformPath {
  return platform === WINDOWS ? win32 : posix;
}
