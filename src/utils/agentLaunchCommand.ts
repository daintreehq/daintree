import type { AgentCliDetail } from "@shared/types/ipc";
import { escapeShellArgOptional, isWindows } from "@shared/utils/shellEscape";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";

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
  platform?: "posix" | "windows"
): string {
  const resolvedPath =
    detail &&
    detail.state !== "missing" &&
    detail.state !== "blocked" &&
    detail.state !== "installed"
      ? detail.resolvedPath?.trim()
      : undefined;

  const effective = resolvedPath ?? registryCommand;
  const isPathLike = effective.includes("/") || effective.includes("\\");
  if (!resolvedPath && !isPathLike) return registryCommand;

  const useWindows = platform ? platform === "windows" : isWindows();
  if (useWindows) {
    return `& '${effective.replace(/'/g, "''")}'`;
  }

  return escapeShellArgOptional(effective, "posix");
}
