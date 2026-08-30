import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_POLICY,
  DEFAULT_TOAST_SIGNALS,
  LAUNCH_MODES,
  chooseStorageDir,
  isAttentionSignal,
  isLaunchLocation,
  isTerminalEngine,
  refuseSplitStore,
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
 * Whether an agent in a terminal of our own may open the channel to the Claude
 * Code extension of this editor BY ITSELF -- `gripterm.terminal.ideChannel`, off
 * unless somebody says otherwise.
 *
 * **By itself, and nothing wider than that.** What the value becomes is
 * `CLAUDE_CODE_AUTO_CONNECT_IDE=false` when it is off (`ideChannelEnv`), and that
 * name governs the CLI's own unasked attempt and no other route to the channel.
 * Measured 2026-08-30: with this setting OFF, `/ide` typed by hand connected all
 * the same, and the agent named the file that was open and the line that was
 * selected -- the token was minted for that run, so neither could be guessed. So
 * this boolean is not permission to reach the extension. A person has that at
 * either value, and the doc this replaced said otherwise for ten days.
 *
 * **And the attempt it does govern was not seen happening at all.** The same
 * measurement raised eight windows -- both editors, both values of this setting,
 * against a Claude Code extension that was installed, live and activated -- and
 * `/ide` at the start showed `None` as the current choice every time. On CLI
 * 2.1.245 with extension 2.1.251 this setting therefore changes nothing that can
 * be observed. It is left standing exactly as it is: what to do with a setting
 * that governs nothing is the owner's to decide, and the question is with him.
 *
 * **What that measurement does not cover, said here rather than discovered.** It
 * ran against a copy of the extension the run installed into a directory of its
 * own, because the windows our runs open do not register Claude Code at all.
 * Whether an ordinary installation behaves the same is NOT established.
 *
 * **What an open channel costs.** The agent is handed the file that is open and
 * the text selected in it (2026-08-20, and again 2026-08-30). And only ONE agent
 * gets the channel however many are running -- a second terminal is told
 * `Failed to connect` while the first keeps what it has, and in VS Code the CLI
 * says it in words: "Only one Claude Code instance can be connected to VS Code
 * at a time" (2026-08-20, held on 2026-08-30).
 *
 * **The cost the default was chosen for is the one that did not come back, and
 * that belongs here, beside the decision it was the ground of.** What the owner
 * refused to pay was the FOCUS, seen 2026-08-20 by hand in VS Code: the editor's
 * own terminal took the focus from our panel on every prompt sent. On 2026-08-30
 * an instrument went looking for it again and did not find it in Cursor -- 163
 * samples over 25 s after a prompt was sent on an open channel, 162 and 155 in
 * the other two arms, and not one watched field moved, while the positive
 * control moved every one of them (`vscode.window.createTerminal(...).show(false)`
 * drove `panelVisible` true to false and `focusedHere` to false in both
 * editors). The connection itself was watched the same way -- 72, 69 and 79
 * samples in Cursor -- and moved nothing; the connection was watched in VS Code
 * too, and moved nothing there either. What was NOT watched is SENDING
 * in VS Code, which is precisely the editor and the moment the 2026-08-20
 * sighting is about: the message budget ran out first. So the price is refuted
 * where it was looked for, unmeasured where it was seen, and withdrawn nowhere.
 * The default stays `false`: that is the owner's decision and his to revisit --
 * but whoever revisits it should know that its ground did not come back.
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

/** Where the store landed, and what the person has to be told about it. */
export interface StorageDirDecision {
  readonly path: string;
  /** Said once, when the window is not using the store its person would expect. */
  readonly announce: string | null;
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
 * A PRODUCTION window can still be wrong about the store in one way, and it is
 * the way that costs the most: `homedir()` is the home of whichever extension
 * host we landed in, and a window connected to a remote landed somewhere else
 * than the local window open on the same folder. Two stores, neither able to
 * read the other's `owners/`, and every conversation unowned on both sides --
 * `refuseSplitStore` says why that is refused rather than survived. The refusal
 * is THROWN for the same reason the test host's is: a store this window has
 * already opened is a store other windows have already been told about, so the
 * only refusal that arrives in time is the one that stops activation. Asked only
 * where the store came from `homedir()`; a development host is given a store of
 * its own further down and told so, and a split somebody was told about is a
 * different question from one nobody was.
 *
 * `extensionKind` in the manifest belongs to the same decision and settles none
 * of it: it says which host we run in (`workspace` -- see
 * `tests/extension/extension-kind.test.ts`), not which home that host has, and a
 * project opened locally and in WSL still has two.
 *
 * Outside a production window the default is not used, and the two hosts are
 * answered differently because the two hosts differ in one decisive way: whether
 * anybody is there to read.
 *
 * A TEST host is REFUSED, and the refusal is THROWN. Refused, because the
 * default path is the store the person keeps their own terminals and
 * conversations in, and a suite running there does not show up as a failing
 * assertion -- it shows up as `claude --resume` starting on somebody's real
 * conversation, as records appearing in their list, and as batches leaving their
 * trash. Thrown, because the guard has to act before anything else does: a
 * refusal carried in the API is read by a test, and a test runs after activation
 * is over. Activation failing is the only refusal that arrives in time.
 *
 * A DEVELOPMENT host is given a store of its own instead, under this extension's
 * `globalStorageUri`, and told so out loud. Refusing here was tried and was
 * wrong: this window is launched by hand as often as by F5 --
 * `cursor --extensionDevelopmentPath=...` carries no user data directory and no
 * setting -- and a refusal there stops the person from running their own product
 * with no way out that the message can name. Their store still cannot be reached
 * by accident; it can be reached on purpose, by setting the path to it, which is
 * the deliberate act I.3 asks for and not a default.
 */
export function readStorageDir(
  logger: Logger,
  context: Pick<vscode.ExtensionContext, 'extensionMode' | 'globalStorageUri'>
): StorageDirDecision {
  const configured = vscode.workspace.getConfiguration(SECTION).get<unknown>(STORAGE_PATH);
  const choice = chooseStorageDir({ configured, home: homedir() });
  if (choice.refused !== null) {
    logger.warn('the configured storage path was not used', {
      setting: `${SECTION}.${STORAGE_PATH}`,
      configured,
      reason: choice.refused,
    });
  }
  if (choice.configured) {
    return { path: choice.path, announce: null };
  }
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    // The one reading of the editor API this rule needs. `env.remoteName` is
    // undefined in a local extension host and named in a remote one, which is
    // exactly the difference between one home and two.
    const split = refuseSplitStore({ remoteName: vscode.env.remoteName, choice });
    if (split !== null) {
      throw new Error(split);
    }
    return { path: choice.path, announce: null };
  }

  const why = choice.refused === null ? 'is not set' : `was refused -- ${choice.refused}`;
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    throw new Error(
      'Gripterm will not open a store it was not pointed at: this window is a test ' +
        `host, and the setting ${SECTION}.${STORAGE_PATH} ${why}, so the store would ` +
        `have been ${choice.path} -- the one this person actually keeps their terminals ` +
        'in. Point the setting at a directory the run owns, the way .vscode-test.mjs, ' +
        'tests/acceptance/run.mjs and tests/vsix/run.mjs write it into the user data ' +
        'they hand to VS Code.'
    );
  }

  const ours = join(context.globalStorageUri.fsPath, 'store');
  logger.warn('this development host was given a store of its own', {
    setting: `${SECTION}.${STORAGE_PATH}`,
    reason: why,
    using: ours,
    insteadOf: choice.path,
  });
  return {
    path: ours,
    announce:
      `Gripterm is a development host here, so it opened a store of its own at ${ours} ` +
      `rather than ${choice.path}. Set ${SECTION}.${STORAGE_PATH} to work against another one.`,
  };
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
