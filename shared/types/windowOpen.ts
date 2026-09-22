/**
 * Which window a project open lands in (#12593). Carried by every open request
 * and resolved in one main-process decision point
 * (`electron/window/windowOpenPolicy.ts`), so the Dock, Finder, CLI, file URIs
 * and the in-app open paths can't drift apart.
 *
 * - `default`: no explicit choice. An open from outside the app gets an empty
 *   window or a new one; an in-app open stays in the window it came from.
 * - `current`: the window the request came from.
 * - `new`: a new window, reusing an empty one before creating another.
 *
 * A window that already owns the project wins over every disposition,
 * including `new` (#12596).
 */
export const PROJECT_OPEN_DISPOSITIONS = ["default", "current", "new"] as const;
export type ProjectOpenDisposition = (typeof PROJECT_OPEN_DISPOSITIONS)[number];

export function isProjectOpenDisposition(value: unknown): value is ProjectOpenDisposition {
  return (
    typeof value === "string" && (PROJECT_OPEN_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/**
 * The user's standing preference for opening folders (#12595), shaped like VS
 * Code's `window.openFoldersInNewWindow`. It only decides opens that carry the
 * `default` disposition; switching to a known project, restore and reveal keep
 * their assigned window whatever it says.
 *
 * - `default`: external opens get a new window, in-app opens stay put.
 * - `on`: every folder open gets a new window.
 * - `off`: every folder open replaces the current window.
 */
export const OPEN_FOLDERS_IN_NEW_WINDOW_VALUES = ["default", "on", "off"] as const;
export type OpenFoldersInNewWindow = (typeof OPEN_FOLDERS_IN_NEW_WINDOW_VALUES)[number];

export const DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW: OpenFoldersInNewWindow = "default";

export function isOpenFoldersInNewWindow(value: unknown): value is OpenFoldersInNewWindow {
  return (
    typeof value === "string" &&
    (OPEN_FOLDERS_IN_NEW_WINDOW_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Where an open ended up, so a window that asked but stayed as it was can tell
 * the request was served elsewhere and clear its own switching state.
 *
 * - `focused`: a window already showing the project was brought forward.
 * - `activated`: the project was opened or switched to inside an existing window.
 * - `created`: a new window was made for it.
 */
export interface ProjectOpenOutcome {
  kind: "focused" | "activated" | "created";
  windowId: number;
}
