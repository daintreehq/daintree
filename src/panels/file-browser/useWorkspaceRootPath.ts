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
 * Resolved by looking this view's own id up in the full collections, not by
 * reading `currentProject`/`currentScratch`. Those pointers are broadcast to
 * every view including cached ones, so they say what the user is looking at
 * globally, never which workspace this view owns: a second window switching to
 * another scratch repoints them here too, and a hook that merely *filtered* on
 * the current pointer would blank this view's open browser for as long as the
 * other window stayed there. Main resolves the same binding when it authorizes
 * the listing, so keying off the seeded id is also what keeps the two sides
 * from naming different folders.
 *
 * Falls back to the current pointers only when the view has no seeded identity
 * at all — an unbound shell window, where nothing else can answer and main
 * refuses the listing anyway.
 */
export function useWorkspaceRootPath(): string {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectPath = useProjectStore((state) => {
    if (viewWorkspaceId === null) return state.currentProject?.path;
    return state.projects.find((project) => project.id === viewWorkspaceId)?.path;
  });
  const scratchPath = useScratchStore((state) => {
    if (viewWorkspaceId === null) return state.currentScratch?.path;
    return state.scratches.find((scratch) => scratch.id === viewWorkspaceId)?.path;
  });

  // Project-first, mirroring `resolveWorkspaceCwd` (#11076). Ids are disjoint
  // across the two tables, so at most one side resolves for a seeded view.
  return projectPath ?? scratchPath ?? "";
}
