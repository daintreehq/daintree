import type { PanelReloadResult } from "./plugin.js";

/**
 * Main → renderer request to reload one plugin panel's view (#12610).
 *
 * `pluginId` is the caller's runtime id as main's host binding knows it, so the
 * renderer can re-validate ownership against its live panel record and kind
 * registry. `expiresAt` (epoch ms) lets a renderer that was frozen when the
 * request arrived drop it instead of reloading long after main gave up.
 */
export interface PluginPanelReloadRequest {
  requestId: string;
  panelId: string;
  pluginId: string;
  expiresAt: number;
}

/** Why the renderer refused to act on a target rather than answering an outcome. */
export type PluginPanelReloadRejection = "foreign" | "non-plugin";

export type PluginPanelReloadResponse =
  | { requestId: string; result: PanelReloadResult }
  | { requestId: string; rejected: PluginPanelReloadRejection };
