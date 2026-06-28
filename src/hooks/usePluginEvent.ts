// Re-export of the canonical renderer-SDK hook shipped as
// `@daintreehq/plugin-sdk/react`. The implementation lives in the package
// source so the published SDK and the host bundle run identical code; this
// shim keeps the in-repo `@/hooks/usePluginEvent` import path stable for plugin
// views bundled inside the host.
export {
  usePluginEvent,
  usePluginPanelEvent,
} from "../../packages/plugin-sdk/src/react/usePluginEvent";
export type { PluginEventHandler } from "../../shared/types/plugin-sdk-react";
