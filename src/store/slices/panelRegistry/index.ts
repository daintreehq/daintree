import type { StateCreator } from "zustand";

import type { PanelRegistrySlice, PanelRegistryMiddleware } from "./types";
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
  AddPanelOptions,
  TrashedTerminal,
  TrashedTerminalGroupMetadata,
  BackgroundedTerminal,
  PanelRegistrySlice,
  PanelRegistryMiddleware,
  PanelRegistryStoreApi,
} from "./types";
export { MAX_GRID_TERMINALS, deriveRuntimeStatus, getDefaultTitle } from "./helpers";
export { flushPanelPersistence } from "./persistence";
export { selectOrderedTerminals } from "./selectors";

export const createPanelRegistrySlice =
  (
    middleware?: PanelRegistryMiddleware
  ): StateCreator<PanelRegistrySlice, [], [], PanelRegistrySlice> =>
  (set, get) => {
    const trashHelpers = createTrashExpiryHelpers(get, set);

    return {
      panelsById: {},
      panelIds: [],
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
