import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { PLUGIN_PARITY_METHOD_CHANNELS } from "./pluginParity.preload.js";
import type {
  InstallOnHostPayload,
  PluginParityPayload,
  PluginParityRow,
} from "../../../shared/types/ipc/pluginParity.js";

export const pluginParityNamespace = defineIpcNamespace({
  name: "pluginParity",
  ops: {
    diff: op(
      PLUGIN_PARITY_METHOD_CHANNELS.diff,
      async (_payload: PluginParityPayload): Promise<PluginParityRow[]> =>
        pendingRemoteHostsHandler(PLUGIN_PARITY_METHOD_CHANNELS.diff)
    ),
    installOnHost: op(
      PLUGIN_PARITY_METHOD_CHANNELS.installOnHost,
      async (_payload: InstallOnHostPayload): Promise<void> =>
        pendingRemoteHostsHandler(PLUGIN_PARITY_METHOD_CHANNELS.installOnHost)
    ),
    updateOnHost: op(
      PLUGIN_PARITY_METHOD_CHANNELS.updateOnHost,
      async (_payload: InstallOnHostPayload): Promise<void> =>
        pendingRemoteHostsHandler(PLUGIN_PARITY_METHOD_CHANNELS.updateOnHost)
    ),
  },
});

export function registerPluginParityHandlers(): () => void {
  return pluginParityNamespace.register();
}
