// Re-export all from the new modular structure for backwards compatibility
export {
  createTerminalRegistrySlice,
  flushTerminalPersistence,
  MAX_GRID_TERMINALS,
  deriveRuntimeStatus,
  getDefaultTitle,
} from "./terminalRegistry";

export type {
  TerminalInstance,
  AddTerminalOptions,
  TrashedTerminal,
  TerminalRegistrySlice,
  TerminalRegistryMiddleware,
  TerminalRegistryStoreApi,
} from "./terminalRegistry";
