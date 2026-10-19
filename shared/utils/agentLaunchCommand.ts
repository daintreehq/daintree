import type { AgentCliDetail } from "../types/ipc/system.js";
import { escapeShellArgOptional, isWindows, quotePowerShellArg } from "./shellEscape.js";

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

/**
 * The executable an agent launch starts: the CLI's probed path when the probe
 * found a launchable one, otherwise the registry command, quoted for the shell
 * of the host the command runs on.
 *
 * `dialect` names that shell; omitted, this process's platform stands in for
 * it. `homeDir` is the home a leading `~` stands for on the host; omitted, a
 * tilde is left for the host's shell to expand.
 */
export function resolveAgentLaunchBaseCommandFor(
  registryCommand: string,
  detail: AgentCliDetail | undefined,
  dialect: "posix" | "windows" | undefined,
  homeDir: string | null | undefined
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

  const useWindows = dialect ? dialect === "windows" : isWindows();
  if (useWindows) {
    return `& ${quotePowerShellArg(effective)}`;
  }

  if (homeDir !== undefined) {
    const expanded = escapeHomeRelativePosix(effective, homeDir);
    if (expanded !== null) return expanded;
  }
  return escapeShellArgOptional(effective, "posix");
}
