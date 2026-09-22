import type { OpenFoldersInNewWindow } from "../windowOpen.js";

/**
 * App-level preferences for how opening a folder picks its window (#12595).
 * The values and their meaning live beside the open policy in
 * `shared/types/windowOpen.ts`.
 */
export interface WindowOpeningConfig {
  openFoldersInNewWindow: OpenFoldersInNewWindow;
}
