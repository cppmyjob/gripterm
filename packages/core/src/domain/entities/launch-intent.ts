/**
 * Why a terminal is being started.
 *
 * It is a PARAMETER and not something derived from the entry, and that is the
 * whole point of its existence. `TerminalEntry.sessionId` is populated on both
 * paths, so nothing in the aggregate distinguishes a first launch from a
 * restore -- while the CLI's own validator refuses `--session-id` together with
 * `--resume` [binary 2.1.224, §4.4]. An implementation that assembled the flags
 * from the entry alone would put the id on both paths and kill every restore at
 * startup, silently and always.
 *
 * The same distinction names the death event: closing in `launching` yields
 * `LaunchExitedNonZero` under `launch` and `ResumeExited` under `resume`
 * (M1.12, M2.11), which is why this type lives in the neutral domain rather
 * than beside one agent's flags.
 *
 * There is deliberately NO `isLaunchIntent` guard beside this. An intent is
 * chosen by the caller in code and never arrives from a settings file or a
 * request body, so a validator would be an untested promise with nobody to
 * keep it.
 */
export const LAUNCH_INTENTS = ['launch', 'resume'] as const;

export type LaunchIntent = (typeof LAUNCH_INTENTS)[number];
