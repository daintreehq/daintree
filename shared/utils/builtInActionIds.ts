import { BUILT_IN_ACTION_IDS } from "../config/actionIds.js";
import { KEY_ACTION_VALUES } from "../types/keymap.js";

// Runtime and keybinding-driven ids alike: both are dispatch targets.
const BUILT_IN: ReadonlySet<string> = new Set([...BUILT_IN_ACTION_IDS, ...KEY_ACTION_VALUES]);

/** Whether `actionId` names a built-in action, runtime or keybinding-driven. */
export function isBuiltInActionId(actionId: string): boolean {
  return BUILT_IN.has(actionId);
}
