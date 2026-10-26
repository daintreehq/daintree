import type { SpawnError } from "@shared/types/pty-host";
import type { HostAgentLimitSnapshot } from "@shared/utils/hostAgentLimit";
import { isClientAppError } from "@/utils/clientAppError";

/**
 * The host and count a launch was refused on at the host's agent ceiling
 * (#14704), off the error main threw. Null for any other failure.
 */
export function hostAgentLimitFromError(error: unknown): HostAgentLimitSnapshot | null {
  if (!isClientAppError(error) || error.details?.code !== "HOST_AGENT_LIMIT_REACHED") return null;
  const { host, count, limit } = error.details;
  return { host, count, limit };
}

/** That refusal as the pane's spawn error, so its banner names the host. Null otherwise. */
export function hostAgentLimitSpawnError(error: unknown): SpawnError | null {
  const hostAgentLimit = hostAgentLimitFromError(error);
  if (hostAgentLimit === null || !isClientAppError(error)) return null;
  return { code: "HOST_AGENT_LIMIT", message: error.userMessage ?? error.message, hostAgentLimit };
}
