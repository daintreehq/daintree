import { CHANNELS } from "../channels.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { typedHandle } from "../utils.js";

let cachedHelpService: typeof HelpServiceModule | null = null;
async function getHelpService(): Promise<typeof HelpServiceModule> {
  if (!cachedHelpService) {
    cachedHelpService = await import("../../services/HelpService.js");
  }
  return cachedHelpService;
}

export function registerHelpHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.HELP_GET_FOLDER_PATH, async () => {
      const HelpService = await getHelpService();
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
