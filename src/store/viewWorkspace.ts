import type { Project, Scratch } from "@shared/types";

/**
 * The workspace a view owns, resolved from its immutable seeded id rather than
 * from whatever the user is looking at globally.
 *
 * `currentProject`/`currentScratch` are broadcast to *every* view, cached ones
 * included, so a second window switching workspaces repoints them here too.
 * Anything that must name this view's own folder — the file browser's root, the
 * workspace an action opens — has to key off {@link getViewWorkspaceId} and look
 * the id up, or it will either blank out or name a sibling window's workspace.
 *
 * Project-first when an id somehow matches both, mirroring `resolveWorkspaceCwd`
 * (#11076) and main's own project-before-scratch resolution, so the two sides
 * never pick different folders for the same id.
 *
 * The `current*` fallbacks apply only to a view with no seeded identity at all —
 * an unbound shell window, where nothing else can answer.
 */
export function resolveViewWorkspace(input: {
  viewWorkspaceId: string | null;
  projects: readonly Project[];
  currentProject: Project | null;
  scratches: readonly Scratch[];
  currentScratch: Scratch | null;
}): { kind: "project"; project: Project } | { kind: "scratch"; scratch: Scratch } | null {
  const { viewWorkspaceId } = input;

  if (viewWorkspaceId === null) {
    if (input.currentProject) return { kind: "project", project: input.currentProject };
    if (input.currentScratch) return { kind: "scratch", scratch: input.currentScratch };
    return null;
  }

  const project = input.projects.find((candidate) => candidate.id === viewWorkspaceId);
  if (project) return { kind: "project", project };

  const scratch = input.scratches.find((candidate) => candidate.id === viewWorkspaceId);
  if (scratch) return { kind: "scratch", scratch };

  return null;
}
