import { defineIpcNamespace, op } from "../define.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { SETTINGS_COPY_METHOD_CHANNELS } from "./settingsCopy.preload.js";
import type { ConfigImportReport } from "../../../shared/types/configBundle.js";
import type {
  SettingsCopyApplyPayload,
  SettingsCopyPreview,
  SettingsCopyPreviewPayload,
} from "../../../shared/types/ipc/settingsCopy.js";

/**
 * Copy this machine's settings to a host (#13346): preview on the host, then
 * apply exactly that preview. Shell-local, so the settings are always this
 * machine's own, whichever host the asking window is attached to.
 */
export const settingsCopyNamespace = defineIpcNamespace({
  name: "settingsCopy",
  ops: {
    preview: op(
      SETTINGS_COPY_METHOD_CHANNELS.preview,
      async (payload: SettingsCopyPreviewPayload): Promise<SettingsCopyPreview> =>
        requireRemoteService("settingsCopyClient").preview(payload)
    ),
    apply: op(
      SETTINGS_COPY_METHOD_CHANNELS.apply,
      async (payload: SettingsCopyApplyPayload): Promise<ConfigImportReport> =>
        requireRemoteService("settingsCopyClient").apply(payload)
    ),
  },
});

export function registerSettingsCopyHandlers(): () => void {
  return settingsCopyNamespace.register();
}
