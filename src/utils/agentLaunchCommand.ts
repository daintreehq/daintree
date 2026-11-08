import type { AgentCliDetail } from "@shared/types/ipc";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { resolveAgentLaunchBaseCommandFor } from "@shared/utils/agentLaunchCommand";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { getHostPlatformInfo, hostShellDialect, isRemoteWindow } from "@/hooks/useHostPlatform";

export async function getCurrentLaunchCliDetail(
  agentId: string,
  forceRefresh = false
): Promise<AgentCliDetail | undefined> {
  const current = useCliAvailabilityStore.getState().details[agentId];
  if (
    !forceRefresh &&
    (current?.state === "ready" || current?.state === "unauthenticated") &&
    current.resolvedPath?.trim()
  ) {
    return current;
  }

  try {
    await useCliAvailabilityStore.getState().refresh(true);
  } catch {
    // Launch can still fall back to the registry command; availability UI
    // surfaces the refresh error separately.
  }

  return useCliAvailabilityStore.getState().details[agentId];
}

export function resolveAgentLaunchBaseCommand(
  registryCommand: string,
  detail: AgentCliDetail | undefined,
  platform?: "posix" | "windows",
  /**
   * The home dir a leading `~` stands for on the host. Defaults to the
   * host's reported home in a remote window; a local window keeps today's
   * command exactly.
   */
  homeDir?: string | null
): string {
  // The command runs on the project's host, whose shell may differ from this client's.
  return resolveAgentLaunchBaseCommandFor(
    registryCommand,
    detail,
    platform ?? hostShellDialect(),
    homeDir !== undefined ? homeDir : isRemoteWindow() ? getHostPlatformInfo().homeDir : undefined
  );
}

/**
 * The executable a launch of `agentId` starts now, for a command built outside the
 * launcher (a resume, a duplicate, a cloned layout): the copy the host detected or
 * the one the user chose, never the bare registry command PATH would resolve.
 * `undefined` for an agent with no registry entry.
 */
export async function resolveCurrentAgentLaunchBaseCommand(
  agentId: string
): Promise<string | undefined> {
  const registryCommand = getEffectiveAgentConfig(agentId)?.command;
  if (registryCommand === undefined) return undefined;
  return resolveAgentLaunchBaseCommand(registryCommand, await getCurrentLaunchCliDetail(agentId));
}
