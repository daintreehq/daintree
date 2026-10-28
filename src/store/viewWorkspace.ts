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

/**
 * This view's own open project row, for a store selector — a store-owned
 * reference, never a fresh object, so an unrelated collection edit doesn't
 * re-render the caller.
 *
 * A closed project stays in `projects` — reopening it from the switcher
 * depends on the row surviving — while this view keeps its seeded id, so
 * {@link resolveViewWorkspace} still finds it after `closeActiveProject`.
 * Mirrors `getProjectForCurrentLocation`, which drops closed rows for the same
 * reason: the welcome screen that replaces a closed project must keep its
 * no-sidebar state (#5023). Literal `=== "closed"` because `status` is
 * optional and an absent one is not closed.
 */
export function selectViewProject(
  viewWorkspaceId: string | null,
  state: { projects: readonly Project[]; currentProject: Project | null }
): Project | undefined {
  const resolved = resolveViewWorkspace({
    viewWorkspaceId,
    projects: state.projects,
    currentProject: state.currentProject,
    scratches: [],
    currentScratch: null,
  });
  if (resolved?.kind !== "project") return undefined;
  return resolved.project.status === "closed" ? undefined : resolved.project;
}

/**
 * This view's own scratch row, for a store selector. Only meaningful once
 * {@link selectViewProject} has found no project, since resolution is
 * project-first.
 */
export function selectViewScratch(
  viewWorkspaceId: string | null,
  state: { scratches: readonly Scratch[]; currentScratch: Scratch | null }
): Scratch | undefined {
  const resolved = resolveViewWorkspace({
    viewWorkspaceId,
    projects: [],
    currentProject: null,
    scratches: state.scratches,
    currentScratch: state.currentScratch,
  });
  return resolved?.kind === "scratch" ? resolved.scratch : undefined;
}
