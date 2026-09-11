/**
 * What the user's login shell exports, for the variables main has to reason
 * about without inheriting them (#12371).
 *
 * The startup probe copies only `PATH` into this process, so a variable a
 * profile exports reaches every terminal Daintree opens but never main itself.
 * Code that needs to know where a CLI in one of those terminals will look asks
 * here. `undefined` means the shell hasn't been observed: the probe failed,
 * timed out, took the PATH-only route, or hasn't finished.
 */

const OBSERVED_NAMES = ["CLAUDE_CONFIG_DIR"] as const;

export type ShellObservedName = (typeof OBSERVED_NAMES)[number];
export type ShellObservedEnv = Readonly<Partial<Record<ShellObservedName, string>>>;

let observed: ShellObservedEnv | undefined;

/** Keep the observed names out of a full shell environment; everything else is dropped. */
export function recordShellEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  const next: Partial<Record<ShellObservedName, string>> = {};
  for (const name of OBSERVED_NAMES) {
    const value = env[name];
    if (value !== undefined) next[name] = value;
  }
  observed = next;
}

export function getShellObservedEnv(): ShellObservedEnv | undefined {
  return observed;
}

export function __resetShellEnvironmentObservationForTests(): void {
  observed = undefined;
}
