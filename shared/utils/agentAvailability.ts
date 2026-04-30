import type { AgentAvailabilityState } from "../types/ipc/system.js";

export function isAgentReady(state: AgentAvailabilityState | undefined): boolean {
  return state === "ready";
}

/**
 * True when the binary exists on disk — covers `installed`, `ready`, and
 * `blocked`. A blocked agent IS installed; it just cannot execute due to
 * endpoint security or missing permissions. Keeping it "installed" means
 * toolbars, pickers, and the setup wizard keep surfacing it so users can
 * see the blocked state and act on it, rather than silently hiding it
 * alongside truly uninstalled agents.
 */
export function isAgentInstalled(state: AgentAvailabilityState | undefined): boolean {
  return (
    state === "installed" || state === "ready" || state === "blocked" || state === "unauthenticated"
  );
}

/** True when the binary is on PATH but no credentials were detected. */
export function isAgentUnauthenticated(state: AgentAvailabilityState | undefined): boolean {
  return state === "unauthenticated";
}

/** True when the binary can be launched (CLI handles auth at runtime). */
export function isAgentLaunchable(state: AgentAvailabilityState | undefined): boolean {
  return state === "ready" || state === "unauthenticated";
}

/**
 * True ONLY when the binary is genuinely not found. A blocked agent is NOT
 * missing — it exists but was prevented from running — so callers that key
 * off "missing" to show install prompts won't erroneously ask users to
 * reinstall a working binary.
 */
export function isAgentMissing(state: AgentAvailabilityState | undefined): boolean {
  return state === "missing" || state === undefined;
}

/**
 * True when the binary exists but execution was denied. Use this in UI
 * surfaces that need to distinguish "install needed" from "allowlist needed".
 */
export function isAgentBlocked(state: AgentAvailabilityState | undefined): boolean {
  return state === "blocked";
}
