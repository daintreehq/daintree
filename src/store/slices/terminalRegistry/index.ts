import type { StateCreator } from "zustand";

import type { TerminalRegistrySlice, TerminalRegistryMiddleware } from "./types";
import { createTrashExpiryHelpers } from "./trash";
import { createCorePanelActions } from "./core";
import { createTrashActions } from "./trashActions";
import { createBackgroundActions } from "./background";
import { createOrderingActions } from "./ordering";
import { createRestartActions } from "./restart";
import { createBrowserActions } from "./browser";
import { createTabGroupActions } from "./tabGroups";

// Re-exports for backward compatibility
export type {
  TerminalInstance,
  AddTerminalOptions,
  TrashedTerminal,
  TrashedTerminalGroupMetadata,
  BackgroundedTerminal,
  TerminalRegistrySlice,
  TerminalRegistryMiddleware,
  TerminalRegistryStoreApi,
} from "./types";
export { MAX_GRID_TERMINALS, deriveRuntimeStatus, getDefaultTitle } from "./helpers";
export { flushTerminalPersistence } from "./persistence";

export const createTerminalRegistrySlice =
  (
    middleware?: TerminalRegistryMiddleware
  ): StateCreator<TerminalRegistrySlice, [], [], TerminalRegistrySlice> =>
  (set, get) => {
    const trashHelpers = createTrashExpiryHelpers(get, set);

    return {
      terminals: [],
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      tabGroups: new Map(),
      ...createCorePanelActions(set, get, trashHelpers, middleware),
      ...createTrashActions(set, get, trashHelpers),
      ...createBackgroundActions(set, get),
      ...createOrderingActions(set, get),
      ...createRestartActions(set, get),
      ...createBrowserActions(set),
      ...createTabGroupActions(set, get),
    };
  };
