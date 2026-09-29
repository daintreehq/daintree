import { escapeShellArgOptional } from "./shellEscape.js";

/**
 * Flags an `agent.launch` caller passed verbatim ride at the end of the
 * persisted `agentLaunchFlags` (#13046), after everything Daintree built from
 * settings. Every path that reconciles or rebuilds the list splits them off
 * first, touches only the settings-derived part, and appends them back last —
 * so a caller's `-c model_reasoning_effort=high` survives exactly as given and
 * keeps overriding earlier values (argv parsers take the last occurrence).
 */

export interface SplitLaunchFlags {
  /** The settings-derived flags Daintree may reconcile or rebuild. */
  base: string[];
  /** The caller's own flags, untouched. */
  caller: string[];
}

function endsWith(flags: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > flags.length) return false;
  const offset = flags.length - suffix.length;
  return suffix.every((flag, index) => flags[offset + index] === flag);
}

/**
 * Separates the caller's segment from a persisted flag list. Ownership is only
 * trusted when the list still ends with exactly those tokens — anything else
 * (a snapshot from before the field existed, or a backend copy that diverged)
 * is treated as all settings-derived, which is how it behaved before.
 */
export function splitCallerLaunchFlags(
  flags: readonly string[] | undefined,
  callerFlags: readonly string[] | undefined
): SplitLaunchFlags {
  const all = [...(flags ?? [])];
  if (!callerFlags?.length || !endsWith(all, callerFlags)) return { base: all, caller: [] };
  return {
    base: all.slice(0, all.length - callerFlags.length),
    caller: [...callerFlags],
  };
}

/** The caller's segment of `flags`, or `[]` when ownership can't be trusted. */
export function readCallerLaunchFlags(
  flags: readonly string[] | undefined,
  callerFlags: readonly string[] | undefined
): string[] {
  return splitCallerLaunchFlags(flags, callerFlags).caller;
}

/**
 * Appends caller flags to a shell command string the way the launcher does:
 * options pass through as typed, values are quoted only when they need it.
 */
export function appendCallerLaunchFlagsToCommand(
  command: string,
  callerFlags: readonly string[] | undefined
): string {
  const tokens = (callerFlags ?? [])
    .filter(Boolean)
    .map((flag) => (flag.startsWith("-") ? flag : escapeShellArgOptional(flag)));
  return tokens.length > 0 ? `${command} ${tokens.join(" ")}` : command;
}
