import { useProjectStore } from "@/store/projectStore";
// Leaf imports, never the `@/store` barrel: many suites mock the barrel
// wholesale without listing these stores, and a barrel import would crash them
// on an undefined destructure.
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { resolveViewWorkspace } from "@/store/viewWorkspace";

/**
 * Absolute path of the workspace *this view* was created for — the project or
 * scratch folder behind a worktree-less browser root (#11482).
 *
 * Resolution rules live in {@link resolveViewWorkspace}, shared with the action
 * context so the folder a Browse-files dispatch names is the folder this pane
 * opens. Each selector returns a string, so Zustand's `Object.is` check keeps an
 * unrelated collection edit from re-rendering the tree.
 */
export function useWorkspaceRootPath(): string {
  const viewWorkspaceId = getViewWorkspaceId();

  const projectPath = useProjectStore((state) => {
    const resolved = resolveViewWorkspace({
      viewWorkspaceId,
      projects: state.projects,
      currentProject: state.currentProject,
      scratches: [],
      currentScratch: null,
    });
    return resolved?.kind === "project" ? resolved.project.path : undefined;
  });

  // Only consulted when the project side didn't answer, so a project-owned view
  // never pays attention to scratch churn.
  const scratchPath = useScratchStore((state) => {
    if (projectPath !== undefined) return undefined;
    const resolved = resolveViewWorkspace({
      viewWorkspaceId,
      projects: [],
      currentProject: null,
      scratches: state.scratches,
      currentScratch: state.currentScratch,
    });
    return resolved?.kind === "scratch" ? resolved.scratch.path : undefined;
  });

  return projectPath ?? scratchPath ?? "";
}
