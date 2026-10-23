import { defineIpcNamespace, op } from "../define.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { HOST_SETTINGS_METHOD_CHANNELS } from "./hostSettings.preload.js";
import type {
  HostSettingsReadPayload,
  HostSettingsSnapshot,
  HostSettingsUpdatePayload,
  HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";

/**
 * A host's own settings, read and changed by name from Settings here
 * (#14167). Shell-local: the host is the one the payload names, never the one
 * the asking window is attached to, and this machine's settings never change.
 */
export const hostSettingsNamespace = defineIpcNamespace({
  name: "hostSettings",
  ops: {
    read: op(
      HOST_SETTINGS_METHOD_CHANNELS.read,
      async (payload: HostSettingsReadPayload): Promise<HostSettingsSnapshot> =>
        requireRemoteService("settingsControlClient").read(payload)
    ),
    update: op(
      HOST_SETTINGS_METHOD_CHANNELS.update,
      async (payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult> =>
        requireRemoteService("settingsControlClient").update(payload)
    ),
  },
});

export function registerHostSettingsHandlers(): () => void {
  return hostSettingsNamespace.register();
}
