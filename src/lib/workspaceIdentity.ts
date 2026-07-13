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
  return { kind: "none", name: "Open project", ariaLabel: "Open project" };
}

/**
 * How the toolbar pill's git-branch chip should render.
 *
 * - `hidden` — not mounted at all. A scratch workspace is never a git repo, so a
 *   faded chip would only reserve blank width beside the name (issue #11084).
 * - `reserved` — mounted but transparent, holding the chip's width. A project's
 *   branch can arrive late (a view first-paints before its project binds) or never
 *   (detached HEAD); collapsing the pill then would shift the titlebar's no-drag
 *   region, which is why the placeholder exists.
 * - `visible` — mounted and showing the branch.
 */
export type BranchChipState = "hidden" | "reserved" | "visible";

export function branchChipState(
  kind: ActiveWorkspaceIdentity["kind"],
  branchName: string | null | undefined
): BranchChipState {
  if (kind === "scratch") return "hidden";
  // `branchName` rides the worktree selection, which closing a project does not
  // clear — so it can outlive `currentProject`. Requiring a project keeps a closed
  // project's branch from lingering beside the "Open project" empty state.
  if (kind !== "project" || !branchName) return "reserved";
  return "visible";
}
