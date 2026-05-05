import type { Scratch } from "../scratch.js";
import type { Project } from "../project.js";

/**
 * Push payload sent to renderers when the active scratch changes. `scratch`
 * is `null` when a project switch deactivates the previously-active scratch.
 */
export interface ScratchSwitchPayload {
  scratch: Scratch | null;
  switchId: string;
}

/** Updates allowed via `scratch:update`. */
export interface ScratchUpdateInput {
  name?: string;
  lastOpened?: number;
}

/**
 * Result of `scratch:save-as-project`. Either the user picked a destination
 * and the scratch was copied + registered as a project, or they cancelled the
 * directory picker.
 */
export type ScratchSaveAsProjectResult =
  | { status: "saved"; project: Project; destinationPath: string }
  | { status: "cancelled" };
