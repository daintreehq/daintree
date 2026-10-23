import type { SpawnError } from "@shared/types/pty-host";
import { isClientAppError } from "@/utils/clientAppError";

/**
 * A launch main refused because plugin tools it requires weren't ready
 * (#14096), as the pane's spawn error: the per-plugin states ride along so the
 * banner can say what is missing and offer to start without them. Null for any
 * other failure.
 */
export function requiredPluginToolsSpawnError(error: unknown): SpawnError | null {
  if (!isClientAppError(error) || error.code !== "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE") return null;
  const details = error.details;
  return {
    code: "REQUIRED_PLUGIN_TOOLS",
    message: error.userMessage ?? error.message,
    ...(details?.code === "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE"
      ? { pluginTools: details.tools }
      : {}),
  };
}
