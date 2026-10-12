import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { AppError } from "../../utils/errorTypes.js";
import { PLUGIN_PARITY_METHOD_CHANNELS } from "./pluginParity.preload.js";
import type {
  InstallOnHostPayload,
  PluginParityPayload,
  PluginParityRow,
} from "../../../shared/types/ipc/pluginParity.js";

/**
 * This machine's plugins against a host's: the diff Settings shows, the
 * one-plugin install or update a person asks for, and the once-per-switch
 * summary notice. Nothing here runs unless the person or a window asks.
 */
export const pluginParityNamespace = defineIpcNamespace({
  name: "pluginParity",
  ops: {
    diff: op(
      PLUGIN_PARITY_METHOD_CHANNELS.diff,
      async (payload: PluginParityPayload): Promise<PluginParityRow[]> =>
        requireRemoteService("pluginParityClient").diff(payload)
    ),
    installOnHost: op(
      PLUGIN_PARITY_METHOD_CHANNELS.installOnHost,
      async (payload: InstallOnHostPayload): Promise<void> =>
        requireRemoteService("pluginParityClient").installOnHost(payload)
    ),
    updateOnHost: op(
      PLUGIN_PARITY_METHOD_CHANNELS.updateOnHost,
      async (payload: InstallOnHostPayload): Promise<void> =>
        requireRemoteService("pluginParityClient").updateOnHost(payload)
    ),
    claimSwitchNotice: op(
      PLUGIN_PARITY_METHOD_CHANNELS.claimSwitchNotice,
      async (ctx: IpcContext, payload: PluginParityPayload): Promise<boolean> => {
        const windowId = ctx.senderWindow?.id;
        if (windowId === undefined) {
          throw new AppError({ code: "VALIDATION", message: "No window for this view" });
        }
        return requireRemoteService("pluginParityClient").claimSwitchNotice(windowId, payload);
      },
      { withContext: true }
    ),
  },
});

export function registerPluginParityHandlers(): () => void {
  return pluginParityNamespace.register();
}
