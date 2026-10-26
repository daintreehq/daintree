import os from "node:os";
import { getRemoteService } from "../remote/runtime.js";
import { AppError } from "../utils/errorTypes.js";
import { machineDisplayName } from "../utils/machineName.js";
import {
  computeHostAgentLimit,
  describeHostAgentLimit,
  type HostAgentLimitSnapshot,
} from "../../shared/utils/hostAgentLimit.js";

interface AgentTerminalCounter {
  countLiveAgentTerminals(excludeId?: string): number;
}

let cachedHostName: string | null = null;
let cachedLimit: number | null = null;

// `machineDisplayName` shells out to scutil on a Mac; the name is read once.
function hostName(): string {
  cachedHostName ??= machineDisplayName();
  return cachedHostName;
}

function hostLimit(): number {
  cachedLimit ??= computeHostAgentLimit(os.totalmem());
  return cachedLimit;
}

/**
 * The host's live agent terminals against its ceiling (#14704), or null while
 * Host mode isn't serving Shells: a machine that serves none is held only to
 * the panel limits of the views on its own screen, as before.
 */
export function readHostAgentLimit(
  counter: AgentTerminalCounter,
  excludeId?: string
): HostAgentLimitSnapshot | null {
  if (getRemoteService("hostServer") === undefined) return null;
  return { host: hostName(), count: counter.countLiveAgentTerminals(excludeId), limit: hostLimit() };
}

/**
 * Refuse an agent terminal the host has no room for. Synchronous, so a caller
 * that spawns in the same turn can't be overtaken by another launch between
 * the count and the spawn.
 */
export function assertHostAgentCapacity(
  counter: AgentTerminalCounter,
  terminalId: string | undefined
): void {
  const snapshot = readHostAgentLimit(counter, terminalId);
  if (snapshot === null || snapshot.count < snapshot.limit) return;
  throw new AppError({
    code: "HOST_AGENT_LIMIT_REACHED",
    message: `Agent launch refused: ${snapshot.count} of ${snapshot.limit} host agent terminals are live`,
    userMessage: describeHostAgentLimit(snapshot),
    details: { code: "HOST_AGENT_LIMIT_REACHED", ...snapshot },
  });
}

export function isHostAgentLimitError(error: unknown): boolean {
  return error instanceof AppError && error.code === "HOST_AGENT_LIMIT_REACHED";
}

export function _resetHostAgentLimitCacheForTest(): void {
  cachedHostName = null;
  cachedLimit = null;
}
