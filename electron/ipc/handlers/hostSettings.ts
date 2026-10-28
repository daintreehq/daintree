import { defineIpcNamespace, op } from "../define.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { HOST_SETTINGS_METHOD_CHANNELS } from "./hostSettings.preload.js";
import type {
  HostSettingsReadPayload,
  HostSettingsSnapshot,
  HostSettingsUpdatePayload,
  HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";

/**
 * A host's own settings, read and changed by name from Settings here
 * (#14167, #14706). Shell-local: the host is the one the payload names, never
 * the one the asking window is attached to. `local` names this machine, for
 * a window attached to another host; any other id is a paired host, and a
 * change meant for one never lands here.
 */
export const hostSettingsNamespace = defineIpcNamespace({
  name: "hostSettings",
  ops: {
    read: op(
      HOST_SETTINGS_METHOD_CHANNELS.read,
      async (payload: HostSettingsReadPayload): Promise<HostSettingsSnapshot> => {
        // The raw define, so a build without Remote Hosts drops the import: no
        // picker there ever names this machine.
        if (__DAINTREE_REMOTE_HOSTS__ && payload?.hostId === LOCAL_HOST_ID) {
          const { readLocalSettings } = await import("../../remote/settingsControl/local.js");
          return readLocalSettings(payload);
        }
        return requireRemoteService("settingsControlClient").read(payload);
      }
    ),
    update: op(
      HOST_SETTINGS_METHOD_CHANNELS.update,
      async (payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult> => {
        // The raw define, so a build without Remote Hosts drops the import: no
        // picker there ever names this machine.
        if (__DAINTREE_REMOTE_HOSTS__ && payload?.hostId === LOCAL_HOST_ID) {
          const { updateLocalSettings } = await import("../../remote/settingsControl/local.js");
          return updateLocalSettings(payload);
        }
        return requireRemoteService("settingsControlClient").update(payload);
      }
    ),
  },
});

export function registerHostSettingsHandlers(): () => void {
  return hostSettingsNamespace.register();
}
