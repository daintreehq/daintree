/**
 * What the user's login shell exports, for the variables main has to reason
 * about without inheriting them (#12371).
 *
 * The startup probe copies only `PATH` into this process, so a variable a
 * profile exports, changes, or unsets reaches every terminal Daintree opens but
 * never main itself. Code that needs to know what a CLI in one of those
 * terminals will see asks here. There is an observation only when the probe ran
 * the shell it named and that shell answered: shell-env's quiet fallbacks to
 * other shells, and finally to this process's own environment, describe no
 * terminal at all.
 */

const OBSERVED_NAMES = ["CLAUDE_CONFIG_DIR"] as const;

export type ShellObservedName = (typeof OBSERVED_NAMES)[number];

export interface ShellEnvironmentObservation {
  /** The shell that was probed, exactly as it was named. */
  readonly shell: string;
  /** Each observed name that shell's environment defines. A missing key means unset. */
  readonly env: Readonly<Partial<Record<ShellObservedName, string>>>;
}

let observation: ShellEnvironmentObservation | undefined;

/** Keep the observed names out of a shell's full environment; everything else is dropped. */
export function recordShellEnvironment(
  shell: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const observed: Partial<Record<ShellObservedName, string>> = {};
  for (const name of OBSERVED_NAMES) {
    const value = env[name];
    if (value !== undefined) observed[name] = value;
  }
  observation = { shell, env: observed };
}

export function getShellEnvironmentObservation(): ShellEnvironmentObservation | undefined {
  return observation;
}

export function __resetShellEnvironmentObservationForTests(): void {
  observation = undefined;
}
