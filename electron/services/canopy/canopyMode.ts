// eager-import-allow: reads Canopy mode via store.get for hydration and idle snapshots without constructing the optional Canopy service
import { CANOPY_MODES, type CanopyMode } from "../../../shared/types/ipc/canopy.js";
import { store } from "../../store.js";

export function isCanopyMode(value: unknown): value is CanopyMode {
  return typeof value === "string" && (CANOPY_MODES as readonly string[]).includes(value);
}

/** Where the user stands on Canopy, as stored; anything unreadable is `unset`. */
export function readCanopyMode(): CanopyMode {
  const mode: unknown = store.get("canopyMode");
  return isCanopyMode(mode) ? mode : "unset";
}
