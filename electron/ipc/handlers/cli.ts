import { CHANNELS } from "../channels.js";
import * as CliInstallService from "../../services/CliInstallService.js";
import { typedHandle } from "../utils.js";

export function registerCliHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.CLI_GET_STATUS, async () => {
      return CliInstallService.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CLI_INSTALL, async () => {
      return CliInstallService.install();
    })
  );

  return () => {
    for (const cleanup of handlers) {
      cleanup();
    }
  };
}
