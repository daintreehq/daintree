import type { McpSessionOrigin } from "../types/ipc/mcpServer.js";
import type { TerminalSpawnSource } from "../types/panel.js";

/**
 * The environment a new terminal is spawned with: global variables under the
 * project's under the caller's launch env, so the most specific layer wins.
 *
 * Shared by the renderer's panel launch and the host's viewless launch, so a
 * terminal gets the same configured tool paths whether or not a window asked
 * for it. With neither ambient layer set the launch env passes through as it
 * is, `undefined` included, and the spawn keeps the process environment.
 */
export function mergeTerminalLaunchEnv(
  globalEnv: Readonly<Record<string, string>> | null | undefined,
  projectEnv: Readonly<Record<string, string>> | null | undefined,
  launchEnv: Record<string, string> | undefined
): Record<string, string> | undefined {
  const hasGlobal = globalEnv != null && Object.keys(globalEnv).length > 0;
  const hasProject = projectEnv != null && Object.keys(projectEnv).length > 0;
  if (!hasGlobal && !hasProject) return launchEnv;
  return { ...globalEnv, ...projectEnv, ...launchEnv };
}

/**
 * The spawn source an MCP-dispatched spawn is stamped with (#11808).
 *
 * `help` and `assistant-pane` are both Daintree's own assistant surfaces, so
 * both read as `"assistant"`. Anything else, including an absent origin, is
 * `"mcp"`: an unknown session must never be promoted into one of Daintree's
 * own surfaces.
 */
export function spawnSourceForMcpOrigin(
  sessionOrigin: McpSessionOrigin | undefined
): TerminalSpawnSource {
  return sessionOrigin === "help" || sessionOrigin === "assistant-pane" ? "assistant" : "mcp";
}
