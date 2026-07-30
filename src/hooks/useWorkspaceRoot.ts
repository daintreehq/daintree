import { useMemo } from "react";
import { isGitBackedProject } from "@shared/types";
import { useProjectStore } from "@/store/projectStore";
// Leaf imports, never the `@/store` barrel: many suites mock the barrel
// wholesale without listing these stores, and a barrel import would crash them
// on an undefined destructure.
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { resolveViewWorkspace } from "@/store/viewWorkspace";

/**
 * The workspace *this view* owns, flattened to the identity chrome needs.
 *
 * A view can be a git-backed project, a folder opened without git (#11405), or
 * a scratch (#11076) — three kinds that until now only the content grid knew
 * how to tell apart. Chrome that has to answer "is there a workspace at all,
 * and does git apply to it" reads this instead of `currentProject != null`,
 * which silently answered "no" for a scratch (#11499).
 */
export interface WorkspaceRoot {
  kind: "project" | "scratch";
  /** Project or scratch id — the workspace's own identity, never a worktree's. */
  id: string;
  /** Absolute filesystem path of the workspace root. */
  path: string;
  /** User-facing display name. */
  name: string;
  /** Whether git-backed surfaces (worktrees, review, diffs, branches) apply. */
  isGitBacked: boolean;
}

/**
 * Resolution rules live in {@link resolveViewWorkspace}, shared with the action
 * context and the file browser's root so every surface names the same folder.
 * Keyed on the view's own seeded id rather than the globally broadcast
 * `currentProject`/`currentScratch`, which a second window switching workspaces
 * repoints in *every* view, cached ones included.
 *
 * Each selector returns a store-owned object reference (or `undefined`), never a
 * freshly built one, so Zustand's `Object.is` check keeps an unrelated
 * collection edit from re-rendering the tree; the flattening happens in a
 * `useMemo` downstream of both.
 */
export function useWorkspaceRoot(): WorkspaceRoot | null {
  const viewWorkspaceId = getViewWorkspaceId();

  const project = useProjectStore((state) => {
    const resolved = resolveViewWorkspace({
      viewWorkspaceId,
      projects: state.projects,
      currentProject: state.currentProject,
      scratches: [],
      currentScratch: null,
    });
    return resolved?.kind === "project" ? resolved.project : undefined;
  });

  // Only consulted when the project side didn't answer, so a project-owned view
  // never pays attention to scratch churn.
  const scratch = useScratchStore((state) => {
    if (project !== undefined) return undefined;
    const resolved = resolveViewWorkspace({
      viewWorkspaceId,
      projects: [],
      currentProject: null,
      scratches: state.scratches,
      currentScratch: state.currentScratch,
    });
    return resolved?.kind === "scratch" ? resolved.scratch : undefined;
  });

  return useMemo<WorkspaceRoot | null>(() => {
    if (project !== undefined) {
      return {
        kind: "project",
        id: project.id,
        path: project.path,
        name: project.name,
        isGitBacked: isGitBackedProject(project),
      };
    }
    if (scratch !== undefined) {
      // Hardcoded, never `isGitBackedProject(null)`: that answers `true` for the
      // legacy no-discriminator case, and a scratch is not a project at all.
      return {
        kind: "scratch",
        id: scratch.id,
        path: scratch.path,
        name: scratch.name,
        isGitBacked: false,
      };
    }
    return null;
  }, [project, scratch]);
}
