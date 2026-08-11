import { shellCommandLine } from './shell-quoting';
import type { AgentCommand } from '../entities/agent-command';
import type { TerminalId } from '../entities/terminal-id';
import type { TerminalSpec } from '../ports/terminal-gateway';
import type { ShellKind } from './shell-quoting';

/**
 * `gripterm.launch.mode`. Default `process` -- A13 closed positively 2026-08-10:
 * the TUI comes up as a first-level pty process with no shell under it, first
 * output at 31 ms, `/exit` giving code 0.
 */
export const LAUNCH_MODES = ['process', 'shell'] as const;

export type LaunchMode = (typeof LAUNCH_MODES)[number];

export interface LaunchPlanParams {
  readonly terminalId: TerminalId;
  /** The title the person sees. Chosen by the lifecycle service, not here. */
  readonly name: string;
  readonly cwd: string;
  readonly command: AgentCommand;
}

/**
 * What the editor has to do to start this terminal.
 *
 * The two fields are mutually exclusive by construction, and the exclusivity is
 * the reason `initialInput` is not simply a field of `TerminalSpec`: a spec
 * holding both a `shellPath` and a line to type would start the agent AND type
 * the command into it, giving two sessions of which we observe one.
 */
export interface LaunchPlan {
  readonly spec: TerminalSpec;
  /** Typed into the terminal once it exists, or `null` when the agent IS the terminal process. */
  readonly initialInput: string | null;
}

/**
 * Turns an argument vector into a terminal, and knows NOTHING about which
 * agent's vector it is.
 *
 * This is the neutral half of the split §4.4 was amended for on 2026-08-10.
 * Quoting for PowerShell is about PowerShell; the flag list is about one CLI;
 * an edit to either must not be able to break the other. The linter holds the
 * line: a file under `domain/services/` importing anything under `agents/`
 * fails the build.
 *
 * `LaunchIntent` is deliberately ABSENT from this signature, unlike the sketch
 * in §4.4. Once the flags moved out, nothing here can act on the intent -- it is
 * already spent, encoded in the vector that arrived.
 */
export interface LaunchStrategy {
  readonly mode: LaunchMode;
  buildPlan: (params: LaunchPlanParams) => LaunchPlan;
}

/**
 * The default. `claude` becomes the terminal process itself.
 *
 * What this buys, in the words of §4.4: the shell-readiness race (A12) cannot
 * occur because there is no shell; the fixed-delay workaround (C1) is not
 * needed; the `sendText` length limit (A11) leaves the launch path; and quoting
 * disappears entirely, which on Windows is not a small thing.
 *
 * What it costs, said out loud: no shell profile runs, so a `PATH` set up by
 * `.bashrc` or `$PROFILE` is not applied, and when `claude` exits the terminal
 * accepts no further command. For a terminal that IS a session, the second is
 * closer to a property than a loss; the first is what `ShellLaunchStrategy`
 * exists for.
 */
export class ProcessLaunchStrategy implements LaunchStrategy {
  public readonly mode = 'process';

  public buildPlan(params: LaunchPlanParams): LaunchPlan {
    return freezePlan({
      spec: {
        terminalId: params.terminalId,
        name: params.name,
        cwd: params.cwd,
        env: params.command.env,
        shellPath: params.command.executable,
        shellArgs: params.command.args,
      },
      initialInput: null,
    });
  }
}

/**
 * The fallback, for machines where `claude` is only on PATH after the shell
 * profile has run.
 *
 * It pays back everything the process mode saved, and the price is stated
 * rather than hidden. Quoting returns, and with it the refusals of
 * `shell-quoting.ts`. The shell-readiness race (A12) returns too: `sendText`
 * queues until the terminal exists, not until its profile has finished, so on a
 * slow profile the line can be typed into a shell that is not yet listening.
 * This mode is opt-in and off by default, and that limit travels with it --
 * A11 and A12 remain open exactly here and nowhere else.
 *
 * The environment still travels through `TerminalSpec.env`, never through the
 * typed line: a token in a shell's scrollback and history is a token disclosed.
 */
export class ShellLaunchStrategy implements LaunchStrategy {
  public readonly mode = 'shell';

  constructor(private readonly _shell: ShellKind) {}

  public buildPlan(params: LaunchPlanParams): LaunchPlan {
    return freezePlan({
      spec: {
        terminalId: params.terminalId,
        name: params.name,
        cwd: params.cwd,
        env: params.command.env,
        // Null, so the editor starts the person's configured shell.
        shellPath: null,
        shellArgs: [],
      },
      initialInput: shellCommandLine(params.command.executable, params.command.args, this._shell),
    });
  }
}

/**
 * A launch plan is read after it is built, and by a different object than built
 * it. Freezing makes "what was launched" and "what was planned" the same
 * sentence.
 */
function freezePlan(plan: LaunchPlan): LaunchPlan {
  Object.freeze(plan.spec);
  return Object.freeze(plan);
}
