import { CHANNELS } from "../channels.js";
import * as HelpService from "../../services/HelpService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { typedHandle } from "../utils.js";

export function registerHelpHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.HELP_GET_FOLDER_PATH, async () => {
      return HelpService.getHelpFolderPath();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.HELP_MARK_TERMINAL, (terminalId: string) => {
      getAgentAvailabilityStore().markAsHelp(terminalId);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.HELP_UNMARK_TERMINAL, (terminalId: string) => {
      getAgentAvailabilityStore().unmarkAsHelp(terminalId);
    })
  );

  return () => {
    for (const cleanup of handlers) {
      cleanup();
    }
  };
}
