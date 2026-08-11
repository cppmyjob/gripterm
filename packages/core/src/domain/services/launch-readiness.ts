import type { ListeningAddress } from '../entities/listening-address';

export interface LaunchInputs {
  /** The name of the agent CLI, for the sentence a person reads. */
  readonly cliName: string;
  /** Where it is, or `null` when it was not found. */
  readonly cliPath: string | null;
  /** This window's hook receiver, or `null` when nothing is listening. */
  readonly address: ListeningAddress | null;
}

/**
 * Either everything a launch needs, or the sentence explaining what is missing.
 *
 * A union rather than a nullable message, so that the composition root has one
 * branch and no unreachable fallback: in the `ready` case the two values are
 * present BY TYPE, and there is nowhere to write a `?? ''` that no test could
 * ever reach.
 */
export type LaunchReadiness =
  | { readonly kind: 'ready', readonly cliPath: string, readonly address: ListeningAddress }
  | { readonly kind: 'refused', readonly reason: string };

/**
 * Whether this window can start a terminal, and why not when it cannot.
 *
 * The second condition is the one worth arguing about, so the argument is
 * written down. Without a receiver the CLI would start perfectly well -- and it
 * would work perfectly well. What we would not have is any way of seeing it: the
 * row would sit in `launching` for the life of the window while somebody held a
 * whole conversation in that terminal. A list that lies is worse than a list
 * that is empty, and being blind is the exact failure this extension exists to
 * remove, so the launch is refused and the reason is said out loud.
 *
 * Neither condition is expected. `claude` missing means it is not installed or
 * not on the PATH the editor inherited; no receiver means five consecutive
 * refusals of an ephemeral loopback port.
 */
export function launchReadiness(inputs: LaunchInputs): LaunchReadiness {
  if (inputs.cliPath === null) {
    return {
      kind: 'refused',
      reason: `Gripterm cannot find ${inputs.cliName} on this machine. Install Claude Code, or start the editor from a shell whose PATH has it, then reload the window.`,
    };
  }
  if (inputs.address === null) {
    return {
      kind: 'refused',
      reason: 'Gripterm has no hook receiver listening, so a terminal started now would run unseen. The reason is in the Gripterm log; reloading the window is the usual fix.',
    };
  }
  return { kind: 'ready', cliPath: inputs.cliPath, address: inputs.address };
}
