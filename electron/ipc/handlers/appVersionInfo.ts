import { app } from "electron";
import os from "node:os";
import { defineIpcNamespace, op } from "../define.js";
import { APP_VERSION_INFO_METHOD_CHANNELS } from "./appVersionInfo.preload.js";
import { buildArchLabel } from "../../utils/archLabel.js";
import type { AppVersionInfo } from "../../../shared/types/ipc/app.js";

export const appVersionInfoNamespace = defineIpcNamespace({
  name: "appVersionInfo",
  ops: {
    getVersionInfo: op(
      APP_VERSION_INFO_METHOD_CHANNELS.getVersionInfo,
      async (): Promise<AppVersionInfo> => {
        return {
          appVersion: app.getVersion(),
          electron: process.versions.electron ?? "",
          chrome: process.versions.chrome ?? "",
          os: `${os.platform()} ${os.release()} (${os.arch()})`,
          arch: buildArchLabel(),
        };
      }
    ),
  },
});

export function registerAppVersionInfoHandlers(): () => void {
  return appVersionInfoNamespace.register();
}
