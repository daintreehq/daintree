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
