import type { AgentCliDetail } from "@shared/types/ipc";
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
