// Re-export all from the new modular structure for backwards compatibility
export {
  createPanelRegistrySlice,
  flushPanelPersistence,
  selectOrderedTerminals,
  MAX_GRID_TERMINALS,
  deriveRuntimeStatus,
  getDefaultTitle,
} from "./panelRegistry";

export type {
  TerminalInstance,
  AddPanelOptions,
  TrashedTerminal,
  TrashedTerminalGroupMetadata,
  BackgroundedTerminal,
  PanelRegistrySlice,
  PanelRegistryMiddleware,
  PanelRegistryStoreApi,
} from "./panelRegistry";
