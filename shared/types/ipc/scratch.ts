import type { Scratch } from "../scratch.js";

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
