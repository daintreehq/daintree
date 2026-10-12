import { DENY_PLUGIN_DISPATCH_ACTION_IDS } from "../../../shared/config/actionIds.js";
import { HOST_DISPATCHABLE_ACTION_IDS } from "../client/hostDispatchableActions.js";

/**
 * Actions the host's MCP may run here that a host's plugin may not. A plugin
 * dispatch runs as `source: "plugin"`, where these reach past the view: the
 * screenshot also lands on this computer's clipboard (only an agent's is
 * returned as bytes alone), and the other two move or re-point this window.
 * The clipboard is reached through the plugin clipboard call, behind this
 * Shell's grant and the front-view check, never through an action.
 */
const BEYOND_THE_VIEW = new Set(["browser.captureScreenshot", "host.switch", "project.openOnHost"]);

/**
 * What a remote host's plugins may dispatch in the view that drives their
 * project, owned by this Shell. Default deny: the audited host-dispatchable
 * set, less every action closed to plugin dispatch everywhere and the ones
 * above. An action a new release adds stays out until it is audited there.
 */
export const HOST_PLUGIN_DISPATCHABLE_ACTION_IDS: ReadonlySet<string> = new Set(
  [...HOST_DISPATCHABLE_ACTION_IDS].filter(
    (id) =>
      !(DENY_PLUGIN_DISPATCH_ACTION_IDS as readonly string[]).includes(id) &&
      !BEYOND_THE_VIEW.has(id)
  )
);

export function isHostPluginDispatchable(actionId: string): boolean {
  return HOST_PLUGIN_DISPATCHABLE_ACTION_IDS.has(actionId);
}
