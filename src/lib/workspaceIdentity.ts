import type { Project, Scratch } from "@shared/types";

export type ActiveWorkspaceIdentity =
  | { kind: "project"; name: string; ariaLabel: string }
  | { kind: "scratch"; name: string; ariaLabel: string }
  | { kind: "none"; name: string; ariaLabel: string };

/**
 * Resolves what the toolbar pill and sidebar switcher should show. `currentProject`
 * and `currentScratch` are mutually exclusive pointers in practice; project still
 * wins here so a stale scratch pointer can never mask an open project.
 */
export function activeWorkspaceIdentity(
  currentProject: Pick<Project, "name"> | null | undefined,
  currentScratch: Pick<Scratch, "name"> | null | undefined
): ActiveWorkspaceIdentity {
  if (currentProject) {
    return {
      kind: "project",
      name: currentProject.name,
      ariaLabel: `Open project switcher for ${currentProject.name}`,
    };
  }
  if (currentScratch) {
    return {
      kind: "scratch",
      name: currentScratch.name,
      ariaLabel: `Open project switcher for scratch ${currentScratch.name}`,
    };
  }
  return { kind: "none", name: "Select project", ariaLabel: "Open project switcher" };
}

/**
 * How the toolbar pill's git-branch chip should render.
 *
 * - `hidden` — not mounted at all. A scratch workspace is never a git repo, and
 *   neither is a folder opened without one (#11405), so a faded chip would only
 *   reserve blank width beside the name (issue #11084). Nothing open has no
 *   branch either, and a closed project's branch can outlive it in the worktree
 *   selection, so the empty state drops the chip rather than risk showing it.
 * - `reserved` — mounted as a placeholder holding the chip's width while a git
 *   project's branch has not arrived (a view first-paints before its project
 *   binds). Collapsing the pill then would shift the titlebar's no-drag region
 *   when the branch lands.
 * - `detached` — HEAD is on a commit, not a branch. That is an answer, not a
 *   wait, so it gets its own chip instead of a placeholder that never resolves.
 * - `visible` — mounted and showing the branch.
 */
export type BranchChipState = "hidden" | "reserved" | "detached" | "visible";

export function branchChipState(
  kind: ActiveWorkspaceIdentity["kind"],
  branchName: string | null | undefined,
  gitBacked: boolean = true,
  isDetached: boolean = false
): BranchChipState {
  if (kind !== "project" || !gitBacked) return "hidden";
  if (branchName) return "visible";
  return isDetached ? "detached" : "reserved";
}
