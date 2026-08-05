import { projectClient } from "@/clients";

/**
 * The project's configured dev-server command, or `undefined` when it is unset
 * or blank.
 *
 * Both paths that can create a dev-preview panel read it here, so a preview
 * opened from the worktree menu or over MCP carries the same command as one
 * opened from the toolbar (#11668). A panel created without it falls back to
 * the settings store at render time, which still leaves it with no command of
 * its own to persist.
 */
export async function readDevServerCommand(projectId: string): Promise<string | undefined> {
  const settings = await projectClient.getSettings(projectId);
  return settings?.devServerCommand?.trim() || undefined;
}
