import * as vscode from 'vscode';
import { homedir } from 'node:os';
import {
  DEFAULT_JOURNAL_POLICY,
  DEFAULT_TOAST_SIGNALS,
  LAUNCH_MODES,
  chooseStorageDir,
  isAttentionSignal,
  isLaunchLocation,
  isTerminalEngine,
} from '@gripterm/core';
import type {
  AttentionSignal,
  JournalPolicy,
  LaunchLocation,
  LaunchMode,
  Logger,
  TerminalEngine,
} from '@gripterm/core';

const SECTION = 'gripterm';
const STORAGE_PATH = 'storage.path';
const TOAST_STATES = 'notify.toastStates';
const LAUNCH_MODE = 'launch.mode';
const LAUNCH_LOCATION = 'launch.location';
const TERMINAL_ENGINE = 'terminal.engine';
const TERMINAL_IDE_CHANNEL = 'terminal.ideChannel';
const JOURNAL_RETENTION_DAYS = 'journal.retentionDays';
const JOURNAL_MAX_SIZE_MB = 'journal.maxSizeMb';
const JOURNAL_INCLUDE_CONTENT = 'journal.includeContent';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** The manifest's defaults and these are the same numbers, taken from core so they cannot drift. */
const DEFAULT_MAX_SIZE_MB = DEFAULT_JOURNAL_POLICY.maxSizeBytes / BYTES_PER_MB;

/** `process`, on the strength of A13: the TUI comes up as a pty process with no shell under it. */
const DEFAULT_LAUNCH_MODE: LaunchMode = 'process';

/** A group of the editor area that is ours -- see `LaunchLocation` for why that is the default. */
const DEFAULT_LAUNCH_LOCATION: LaunchLocation = 'group';

/**
 * `editor`, and the measurements of M3.1-M3.12 are why it stays that way -- the
 * owner's decision of 2026-08-20 (M3.13).
 *
 * Not because the other engine is unfinished: it makes terminals, brings them
 * back after a restart and draws them beside what is known about them. Because
 * of what a person would lose without having asked for it.
 *
 * An `environmentVariableCollection` belonging to another extension reaches the
 * terminals the EDITOR makes and cannot reach a pty of ours -- measured
 * 2026-08-20 (A42): a terminal of ours under this engine carries the Claude Code
 * extension's `CLAUDE_CODE_SSE_PORT` and the editor's `GIT_ASKPASS`, and under
 * `own` neither is gettable, because the stable API exposes only our own
 * collection. node-pty carries no Linux build at all, so `own` there is a
 * fallback and nothing else. And the acceptance a person has to walk by hand is
 * finished in one editor of the two.
 *
 * Changing this is four lines and a test. The default is not the direction the
 * work is going; it is the direction the loss is.
 */
const DEFAULT_TERMINAL_ENGINE: TerminalEngine = 'editor';

/**
 * Which states get a notification, as the person configured them.
 *
 * A settings file can say anything -- a typo, a state we renamed, a state from
 * a newer build. Every one of those is REPORTED rather than dropped into a set
 * that then silently never matches: a notification that stops arriving because
 * of a typo is indistinguishable from a notification we forgot to send, which
 * is the failure this whole extension exists to prevent.
 *
 * An empty list is a legitimate answer -- "do not interrupt me" -- and is left
 * alone. Only an ABSENT setting falls back to the default.
 */
export function readToastSignals(logger: Logger): readonly AttentionSignal[] {
  const configured = vscode.workspace.getConfiguration(SECTION).get<readonly string[]>(TOAST_STATES);
  if (configured === undefined) {
    return DEFAULT_TOAST_SIGNALS;
  }

  const known = configured.filter((value) => isAttentionSignal(value));
  if (known.length !== configured.length) {
    logger.warn('some configured notification states are not states this build knows', {
      setting: `${SECTION}.${TOAST_STATES}`,
      unknown: configured.filter((value) => !isAttentionSignal(value)),
    });
  }
  return known;
}

/**
 * How a terminal is started, as the person configured it.
 *
 * The two modes are not interchangeable and the difference is not cosmetic:
 * `process` makes `claude` the terminal's own process, with no shell to quote
 * for and no readiness race; `shell` types a command line into the person's
 * shell, which is what a machine whose PATH is set up by a profile needs, and
 * pays for it with A11 and A12 (§4.4). An unreadable value falls back to the
 * default AND says so -- a typo that silently changed how terminals start would
 * be discovered by its consequences.
 */
export function readLaunchMode(logger: Logger): LaunchMode {
  const configured = vscode.workspace.getConfiguration(SECTION).get<string>(LAUNCH_MODE);
  if (configured === undefined) {
    return DEFAULT_LAUNCH_MODE;
  }
  if ((LAUNCH_MODES as readonly string[]).includes(configured)) {
    return configured as LaunchMode;
  }

  logger.warn('the configured launch mode is not one this build knows', {
    setting: `${SECTION}.${LAUNCH_MODE}`,
    configured,
    using: DEFAULT_LAUNCH_MODE,
  });
  return DEFAULT_LAUNCH_MODE;
}

/**
 * Where a terminal is opened, as the person configured it.
 *
 * Same rule as above and for the same reason: an unreadable value falls back
 * AND says so. A setting that silently did nothing would be indistinguishable
 * from a setting we forgot to implement.
 */
export function readLaunchLocation(logger: Logger): LaunchLocation {
  const configured = vscode.workspace.getConfiguration(SECTION).get<string>(LAUNCH_LOCATION);
  if (configured === undefined) {
    return DEFAULT_LAUNCH_LOCATION;
  }
  if (isLaunchLocation(configured)) {
    return configured;
  }

  logger.warn('the configured launch location is not one this build knows', {
    setting: `${SECTION}.${LAUNCH_LOCATION}`,
    configured,
    using: DEFAULT_LAUNCH_LOCATION,
  });
  return DEFAULT_LAUNCH_LOCATION;
}

/**
 * Which engine opens a terminal, as the person configured it.
 *
 * Same rule as the two above -- an unreadable value falls back AND says so -- and
 * it matters more here than anywhere else in this file: this setting decides
 * whether a conversation runs inside the editor's own terminal or inside a
 * process of ours, and the two are ended by different machinery. A typo that
 * silently meant `editor` would be discovered by a person wondering why the
 * screen they configured never appeared.
 *
 * What is asked for is not necessarily what answers: `own` with
 * `gripterm.launch.mode: shell` is refused, and `own` on a build whose native
 * addon will not load falls back. Both happen in `terminalGatewayFor`, out loud,
 * and the record is stamped from the gateway that answered rather than from here.
 */
/**
 * Whether a terminal of our own may reach the Claude Code extension of this
 * editor -- `gripterm.terminal.ideChannel`, off unless somebody says otherwise.
 *
 * **Both sides of it were measured on 2026-08-20, by hand, in a real window.**
 * ON, the agent is handed the file that is open and the text selected in it --
 * asked which file and what selection, it named both. The price is that the
 * editor's own terminal takes the focus from our panel on every prompt sent, and
 * that only ONE agent gets the channel however many are running: the CLI says so
 * itself. The owner refused to pay the focus by default, and this is that
 * decision written where the setting is read.
 *
 * Anything that is not exactly `true` leaves it off, the same rule the journal's
 * content switch follows: a setting we cannot read is not permission.
 *
 * It reaches only the `own` engine. Under `editor` the terminals are the
 * editor's, the extension gives them its port itself, and nothing here is in the
 * middle of that.
 */
export function readIdeChannel(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<unknown>(TERMINAL_IDE_CHANNEL) === true;
}

export function readTerminalEngine(logger: Logger): TerminalEngine {
  const configured = vscode.workspace.getConfiguration(SECTION).get<string>(TERMINAL_ENGINE);
  if (configured === undefined) {
    return DEFAULT_TERMINAL_ENGINE;
  }
  if (isTerminalEngine(configured)) {
    return configured;
  }

  logger.warn('the configured terminal engine is not one this build knows', {
    setting: `${SECTION}.${TERMINAL_ENGINE}`,
    configured,
    using: DEFAULT_TERMINAL_ENGINE,
  });
  return DEFAULT_TERMINAL_ENGINE;
}

/**
 * Where the store lives, as the person configured it.
 *
 * Read once, at activation, and a change needs a window reload -- which is why
 * `onDidChangeConfiguration` is not taken for this key either, although §4.8
 * once expected it to be. Moving the base while a window is running would mean
 * re-announcing this window's presence, rewriting every terminal's
 * `settings.json` -- files the running CLI has already read -- and leaving the
 * hooks of live terminals pointing into the directory we just left. Re-creating
 * the watcher alone, which is all the milestone asked for, would leave this
 * window WATCHING a directory nothing writes to: a list that never changes and
 * never says why. A reload re-creates all of it, in order, and the manifest says
 * so on the setting.
 *
 * Outside a production window this refuses instead of falling back, and the
 * refusal is thrown rather than reported. Both halves are deliberate.
 *
 * REFUSES, because the default path is the store the person keeps their own
 * terminals and conversations in, and a test host or a development host running
 * on it is not a mistake that shows up as a failing assertion -- it shows up as
 * `claude --resume` starting on somebody's real conversation, as records
 * appearing in their list, and as batches leaving their trash. A run that was
 * pointed nowhere asked for the default by not asking, and by not asking it
 * cannot have meant that one.
 *
 * THROWN, because the guard has to act before anything else does. A refusal
 * carried in the API is read by a test, and a test runs after activation is
 * over -- after the store has been opened, the window announced and the survey
 * begun. There is no assertion that can un-write those. Activation failing is
 * the only refusal that arrives in time, and every suite sees it at once.
 */
export function readStorageDir(logger: Logger, mode: vscode.ExtensionMode): string {
  const configured = vscode.workspace.getConfiguration(SECTION).get<unknown>(STORAGE_PATH);
  const choice = chooseStorageDir({ configured, home: homedir() });
  if (choice.refused !== null) {
    logger.warn('the configured storage path was not used', {
      setting: `${SECTION}.${STORAGE_PATH}`,
      configured,
      reason: choice.refused,
      using: choice.path,
    });
  }
  if (mode !== vscode.ExtensionMode.Production && !choice.configured) {
    const host = mode === vscode.ExtensionMode.Test ? 'a test host' : 'a development host';
    const why = choice.refused === null ? 'is not set' : `was refused -- ${choice.refused}`;
    throw new Error(
      `Gripterm will not open a store it was not pointed at: this window is ${host}, ` +
        `and the setting ${SECTION}.${STORAGE_PATH} ${why}, so the store would have been ` +
        `${choice.path} -- the one this person actually keeps their terminals in. Point ` +
        'the setting at a directory the run owns, the way .vscode-test.mjs, ' +
        'tests/acceptance/run.mjs and tests/vsix/run.mjs write it into the user data ' +
        'they hand to VS Code.'
    );
  }
  return choice.path;
}

/**
 * What the journal is allowed to keep, as the person configured it.
 *
 * Read once, at activation, like every other setting here: a change takes effect
 * when the window reloads. That is worth saying out loud for `includeContent`,
 * because a privacy setting that appears to take effect and does not is worse
 * than one that plainly asks for a reload.
 */
export function readJournalPolicy(logger: Logger): JournalPolicy {
  const section = vscode.workspace.getConfiguration(SECTION);
  const includeContent = section.get<unknown>(JOURNAL_INCLUDE_CONTENT);

  return {
    // Anything that is not exactly `true` leaves the texts out. The default is
    // off, and a setting we cannot read is not a licence to start writing them.
    includeContent: includeContent === true,
    retentionDays: readCount(
      section,
      JOURNAL_RETENTION_DAYS,
      DEFAULT_JOURNAL_POLICY.retentionDays,
      logger
    ),
    maxSizeBytes: readCount(section, JOURNAL_MAX_SIZE_MB, DEFAULT_MAX_SIZE_MB, logger) *
      BYTES_PER_MB,
  };
}

/**
 * A count the person may set to zero -- "keep nothing but today" is a legitimate
 * answer -- but not to a negative or to something that is not a number, both of
 * which would turn retention into arithmetic nobody meant.
 */
function readCount(
  section: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  logger: Logger
): number {
  const configured = section.get<unknown>(key);
  if (configured === undefined) {
    return fallback;
  }
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  logger.warn('a configured journal limit is not a number this build can use', {
    setting: `${SECTION}.${key}`,
    configured,
    using: fallback,
  });
  return fallback;
}
