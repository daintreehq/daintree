import { useProjectStore } from "@/store/projectStore";
// Leaf imports, never the `@/store` barrel: many suites mock the barrel
// wholesale without listing these stores, and a barrel import would crash them
// on an undefined destructure.
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/**
 * Absolute path of the workspace *this view* was created for — the project or
 * scratch folder behind a worktree-less browser root (#11482).
 *
 * Matched against `getViewWorkspaceId()` rather than read straight off the
 * current pointers: `currentProject`/`currentScratch` are broadcast to every
 * view including cached ones, so they say what the user is looking at globally,
 * never which workspace this view owns. Main resolves the same binding when it
 * authorizes the listing, so pinning the renderer to it is what keeps the two
 * sides from ever naming different folders.
 *
 * Falls back to the raw pointers only when the view has no seeded identity at
 * all (a test or shell view) — precisely the case where the global value is the
 * only answer available.
 */
export function useWorkspaceRootPath(): string {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectPath = useProjectStore((state) => {
    const project = state.currentProject;
    if (!project) return undefined;
    if (viewWorkspaceId !== null && project.id !== viewWorkspaceId) return undefined;
    return project.path;
  });
  const scratchPath = useScratchStore((state) => {
    const scratch = state.currentScratch;
    if (!scratch) return undefined;
    if (viewWorkspaceId !== null && scratch.id !== viewWorkspaceId) return undefined;
    return scratch.path;
  });

  // Project-first, mirroring `resolveWorkspaceCwd` (#11076): both pointers are
  // briefly set while a cached view catches up on a switch broadcast.
  return projectPath ?? scratchPath ?? "";
}
