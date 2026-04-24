import type { BuiltInAgentId } from "../../shared/config/agentIds.js";
import type { AgentId } from "../../shared/types/agent.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";

type MaybeAgentId = BuiltInAgentId | AgentId | string | undefined;

export interface ChromeIdentityInput {
  detectedAgentId?: BuiltInAgentId;
  /** Accepted for call-site compatibility but intentionally ignored by chrome. */
  launchAgentId?: MaybeAgentId;
  /** Accepted for call-site compatibility but intentionally ignored by chrome. */
  everDetectedAgent?: boolean;
}

/**
 * Chrome identity is a pure read of the live process running inside the PTY.
 * Launch hints, ever-detected stickiness, and heuristics do NOT drive chrome.
 *
 * The contract:
 *   `chrome agent id === detectedAgentId`
 *
 * When the process detector commits an agent, chrome lights up. When the agent
 * exits and the detector clears, chrome reverts to a plain terminal on the
 * next tick. No in-between states, no fallback to "what this was launched as".
 */
export function resolveChromeAgentId(panel: ChromeIdentityInput | undefined): string | undefined;
export function resolveChromeAgentId(
  detectedAgentId: BuiltInAgentId | undefined,
  launchAgentId?: MaybeAgentId,
  everDetectedAgent?: boolean
): string | undefined;
export function resolveChromeAgentId(
  arg1: ChromeIdentityInput | BuiltInAgentId | undefined,
  _launchAgentId?: MaybeAgentId,
  _everDetectedAgent?: boolean
): string | undefined {
  if (arg1 && typeof arg1 === "object") return arg1.detectedAgentId ?? undefined;
  return arg1 ?? undefined;
}

export function resolveChromeBuiltInAgentId(
  panel: ChromeIdentityInput | undefined
): BuiltInAgentId | undefined;
export function resolveChromeBuiltInAgentId(
  detectedAgentId: BuiltInAgentId | undefined,
  launchAgentId?: MaybeAgentId,
  everDetectedAgent?: boolean
): BuiltInAgentId | undefined;
export function resolveChromeBuiltInAgentId(
  arg1: ChromeIdentityInput | BuiltInAgentId | undefined,
  launchAgentId?: MaybeAgentId,
  everDetectedAgent?: boolean
): BuiltInAgentId | undefined {
  const resolved =
    arg1 && typeof arg1 === "object"
      ? resolveChromeAgentId(arg1)
      : resolveChromeAgentId(arg1, launchAgentId, everDetectedAgent);
  return isBuiltInAgentId(resolved) ? resolved : undefined;
}

/**
 * Is this terminal currently hosting an agent? Live-detection answer only.
 */
export function isAgentTerminalLive(
  input: BuiltInAgentId | ChromeIdentityInput | undefined
): boolean {
  if (!input) return false;
  if (typeof input === "object") return input.detectedAgentId !== undefined;
  return true;
}
