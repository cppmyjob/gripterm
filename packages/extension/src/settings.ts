import * as vscode from 'vscode';
import { DEFAULT_TOAST_SIGNALS, isAttentionSignal } from '@gripterm/core';
import type { AttentionSignal, Logger } from '@gripterm/core';

const SECTION = 'gripterm';
const TOAST_STATES = 'notify.toastStates';

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
