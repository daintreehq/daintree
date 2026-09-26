import type { AgentCliDetail } from "@shared/types/ipc";
import { escapeShellArgOptional, isWindows } from "@shared/utils/shellEscape";
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

/**
 * `~` and `~/rest` with the host's home in place of the tilde. Quoting would
 * otherwise hand the host's shell a literal `~`, which it never expands. With
 * no home reported yet the tilde is left bare and only the rest is quoted, so
 * the host's shell still expands it.
 */
function escapeHomeRelativePosix(path: string, homeDir: string | null): string | null {
  if (path !== "~" && !path.startsWith("~/")) return null;
  const rest = path.slice(1);
  if (homeDir) return escapeShellArgOptional(homeDir.replace(/\/+$/, "") + rest, "posix");
  return rest.length > 1 ? `~/${escapeShellArgOptional(rest.slice(1), "posix")}` : "~";
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

  // The command runs on the project's host, whose shell may differ from this client's.
  const dialect = platform ?? hostShellDialect();
  const useWindows = dialect ? dialect === "windows" : isWindows();
  if (useWindows) {
    return `& '${effective.replace(/'/g, "''")}'`;
  }

  const home =
    homeDir !== undefined ? homeDir : isRemoteWindow() ? getHostPlatformInfo().homeDir : undefined;
  if (home !== undefined) {
    const expanded = escapeHomeRelativePosix(effective, home);
    if (expanded !== null) return expanded;
  }
  return escapeShellArgOptional(effective, "posix");
}
