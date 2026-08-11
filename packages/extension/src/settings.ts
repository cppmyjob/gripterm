import * as vscode from 'vscode';
import { DEFAULT_TOAST_SIGNALS, LAUNCH_MODES, isAttentionSignal, isLaunchLocation } from '@gripterm/core';
import type { AttentionSignal, LaunchLocation, LaunchMode, Logger } from '@gripterm/core';

const SECTION = 'gripterm';
const TOAST_STATES = 'notify.toastStates';
const LAUNCH_MODE = 'launch.mode';
const LAUNCH_LOCATION = 'launch.location';

/** `process`, on the strength of A13: the TUI comes up as a pty process with no shell under it. */
const DEFAULT_LAUNCH_MODE: LaunchMode = 'process';

/** The editor area -- see `LaunchLocation` for why that is the default rather than the panel. */
const DEFAULT_LAUNCH_LOCATION: LaunchLocation = 'editor';

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
