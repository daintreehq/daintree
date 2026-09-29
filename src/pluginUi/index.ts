// The runtime of `@daintreehq/plugin-ui`, served to plugin views through the
// host import map. Every export here is public contract: vite.config.ts pins
// the names in HOST_FACADE_REQUIRED_EXPORTS and the SDK declares their types in
// packages/plugin-sdk/plugin-ui.d.ts.
export { Markdown } from "./Markdown";
export type { PluginMarkdownProps as MarkdownProps } from "@shared/types/plugin-sdk-react";
