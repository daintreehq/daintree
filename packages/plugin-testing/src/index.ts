export { createMockHost } from "../../../shared/testing/createMockHost.js";

export type {
  CreateMockHostOptions,
  MockHostState,
  RegisteredActionRecord,
  RegisteredHandlerRecord,
  BroadcastRecord,
  ShownToastRecord,
  DispatchedActionRecord,
  RegisteredForgeProviderRecord,
  RegisteredFileDecorationProviderRecord,
  InvalidationRecord,
  ShowQuickPickRecord,
  ShowInputBoxRecord,
  ShowConfirmRecord,
} from "../../../shared/testing/createMockHost.js";

// Re-exported so plugin authors can type `seedActionCatalog` entries without a
// direct `shared/` import (#10578).
export type {
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "../../../shared/types/actions.js";
