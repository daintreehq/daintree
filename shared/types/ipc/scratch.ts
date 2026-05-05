import type { Scratch } from "../scratch.js";

/** Push payload sent to renderers when the user switches to a scratch workspace. */
export interface ScratchSwitchPayload {
  scratch: Scratch;
  switchId: string;
}

/** Updates allowed via `scratch:update`. */
export interface ScratchUpdateInput {
  name?: string;
  lastOpened?: number;
}
