import * as CliInstallService from "../../services/CliInstallService.js";
import { defineIpcNamespace, op } from "../define.js";
import { CLI_METHOD_CHANNELS } from "./cli.preload.js";

export const cliNamespace = defineIpcNamespace({
  name: "cli",
  ops: {
    install: op(CLI_METHOD_CHANNELS.install, async () => {
      return CliInstallService.install();
    }),
    getStatus: op(CLI_METHOD_CHANNELS.getStatus, async () => {
      return CliInstallService.getStatus();
    }),
  },
});

export function registerCliHandlers(): () => void {
  return cliNamespace.register();
}
