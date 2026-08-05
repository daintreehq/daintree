import { projectClient } from "@/clients";
// Leaf imports, never the `@/store` barrel: suites that mock the barrel
// wholesale would crash on an undefined destructure.
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { resolveViewWorkspace } from "@/store/viewWorkspace";

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

/**
 * The configured dev-server command for the project *this view* owns.
 *
 * Deliberately not `currentProject`: that is broadcast to every view, so a
 * second window switching projects repoints it here too, and the preview would
 * run a sibling project's command in this project's folder. A scratch-owned or
 * unresolved view has no project settings and yields `undefined`.
 *
 * A settings read that fails resolves to `undefined` rather than rejecting —
 * the preview still opens and falls back to the settings store at render time,
 * and a launch is not worth failing over a command lookup.
 */
export async function readViewDevServerCommand(): Promise<string | undefined> {
  const state = useProjectStore.getState();
  const resolved = resolveViewWorkspace({
    viewWorkspaceId: getViewWorkspaceId(),
    projects: state.projects,
    currentProject: state.currentProject,
    scratches: [],
    currentScratch: null,
  });
  if (resolved?.kind !== "project") return undefined;
  return readDevServerCommand(resolved.project.id).catch(() => undefined);
}
