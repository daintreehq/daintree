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
