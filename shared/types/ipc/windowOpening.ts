/**
 * Where an opened folder goes, shaped like VS Code's
 * `window.openFoldersInNewWindow` (#12595):
 *
 * - `default` — a folder opened from outside Daintree (Dock, Finder, command
 *   line) gets a new window; one picked inside Daintree replaces the current
 *   window's project.
 * - `on` — always a new window.
 * - `off` — always the current window.
 *
 * Governs opening a folder, never navigating: the project switcher, project
 * history, focusing a waiting agent, MCP reveal and session restore keep their
 * assigned window whatever the value.
 */
export const OPEN_FOLDERS_IN_NEW_WINDOW_MODES = ["default", "on", "off"] as const;

export type OpenFoldersInNewWindowMode = (typeof OPEN_FOLDERS_IN_NEW_WINDOW_MODES)[number];

export const DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW: OpenFoldersInNewWindowMode = "default";

export function isOpenFoldersInNewWindowMode(value: unknown): value is OpenFoldersInNewWindowMode {
  return (
    typeof value === "string" &&
    (OPEN_FOLDERS_IN_NEW_WINDOW_MODES as readonly string[]).includes(value)
  );
}

/** App-level preferences for how opening a folder picks its window. */
export interface WindowOpeningConfig {
  openFoldersInNewWindow: OpenFoldersInNewWindowMode;
}
