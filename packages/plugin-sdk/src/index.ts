export type * from "../../../shared/types/plugin-sdk.js";
// Runtime value re-exports — `export type *` above strips value bindings, so
// each runtime const the SDK surfaces needs an explicit value line (mirrors the
// pattern in `react.ts`). `PLUGIN_PROCESS_STREAM_CHANNEL` must reach authors as
// a real string so `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)` resolves
// the channel at runtime — a type-only re-export would emit `undefined` (#10515).
export { PLUGIN_PROCESS_STREAM_CHANNEL } from "../../../shared/types/plugin-sdk.js";
// `localAuthStubs` is a runtime const a local/offline forge provider spreads
// into its impl, so it needs an explicit value re-export for the same reason.
export { localAuthStubs } from "../../../shared/types/plugin-sdk.js";
// `PLUGIN_STYLE_ROOT_ATTRIBUTE` is the data attribute a panel's style root
// must carry; authors read it at runtime, so the api-report's value declaration
// needs a real binding behind it.
export { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../shared/types/plugin-sdk.js";
// The agent-context drag contract: a view sets the type and payload at
// `dragstart`, so the constants and the helper need real bindings.
export {
  AGENT_CONTEXT_DRAG_MIME,
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH,
  setAgentContextDragData,
  encodeAgentContextDragPayload,
} from "../../../shared/types/plugin-sdk.js";
// "Pull on mount, then push deltas": the worker half of the synced-collection
// protocol `useSyncedCollection` (in `/react`) mirrors. A runtime export of the
// root entry so zero-build workers, which are served this entry, can use it.
export {
  createSyncedCollection,
  syncedCollectionSnapshotChannel,
  type SyncedCollection,
  type SyncedCollectionDelta,
  type SyncedCollectionHost,
  type SyncedCollectionOptions,
  type SyncedCollectionSnapshot,
} from "./sync/syncedCollection.js";
