import type { Project } from "../../shared/types/project.js";

/** Shown when no project is on screen: the picker, a scratch, an unbound window. */
export const FALLBACK_WINDOW_TITLE = "Daintree";

/**
 * Mission Control and the Dock menu elide long titles anyway, and a runaway
 * name would push the waiting-count prefix out of view. Matches the 100-char
 * ceiling the project-identity creation paths already apply.
 */
const MAX_TITLE_LENGTH = 100;

/** Control characters render as glyphs in an NSWindow title rather than breaking the line. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** The slice of a project row title resolution needs. */
export type ProjectTitleRow = Pick<Project, "name" | "status">;

export type ProjectTitleLookup = (projectId: string) => ProjectTitleRow | null;

/** The `ProjectViewManager` surface title resolution reads — narrow so the resolver stays testable. */
export interface TitleProjectViewManager {
  getActiveProjectId(): string | null;
  getOutgoingBridgeProjectId(): string | null;
}

/**
 * The name of the project a window is currently displaying, or null when none is.
 *
 * Mirrors `resolveProjectIdForApplicationMenu` (projectMenuState.ts), which
 * answers the same question for the process-global menu bar. Never consults
 * `projectStore.getCurrentProjectId()`: that global pointer names whichever
 * window switched most recently, so with two windows open it routinely answers
 * for the wrong one (#11101) — the exact confusion this title is meant to end.
 *
 * A raw ProjectViewManager id is not proof a project is open. Scratch
 * workspaces share the PVM and surface an id with no project row, and closing a
 * project marks its row "closed" while leaving the window's binding pointed at
 * it. Only "closed" is rejected: project status is process-global, so a project
 * visible in a non-focused window is legitimately "background".
 */
export function resolveWindowProjectName(
  pvm: TitleProjectViewManager | undefined,
  lookup: ProjectTitleLookup | null
): string | null {
  if (!pvm || !lookup) return null;

  // A cold switch flips `activeProjectId` to the incoming project while the
  // outgoing view stays on screen as the anti-flash bridge. Answer with what is
  // actually painted, or the window renames itself before the user sees why.
  const bridged = openProjectName(pvm.getOutgoingBridgeProjectId(), lookup);
  return bridged ?? openProjectName(pvm.getActiveProjectId(), lookup);
}

function openProjectName(projectId: string | null, lookup: ProjectTitleLookup): string | null {
  if (!projectId) return null;
  const project = lookup(projectId);
  if (!project || project.status === "closed") return null;
  return project.name ?? null;
}

/**
 * The native title for one window: `(N) projectName`, falling back to the app
 * name when no project is on screen.
 *
 * The app name is deliberately not appended after a project name — the Dock
 * already groups every window under one icon, so repeating it costs the space
 * that distinguishes the windows.
 */
export function composeWindowTitle(
  projectName: string | null | undefined,
  waitingCount: number
): string {
  const base = normalizeProjectName(projectName) ?? FALLBACK_WINDOW_TITLE;
  return waitingCount > 0 ? `(${waitingCount}) ${base}` : base;
}

/** Null when nothing displayable survives, so the caller falls back to the app name. */
function normalizeProjectName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;

  const cleaned = name.replace(CONTROL_CHARS, " ").trim();
  if (!cleaned) return null;

  const points = [...cleaned];
  if (points.length <= MAX_TITLE_LENGTH) return cleaned;
  return `${points.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`;
}
