import { defineIpcNamespace, op } from "../define.js";
import { HELP_METHOD_CHANNELS } from "./help.preload.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";

let cachedHelpService: typeof HelpServiceModule | null = null;
async function getHelpService(): Promise<typeof HelpServiceModule> {
  if (!cachedHelpService) {
    cachedHelpService = await import("../../services/HelpService.js");
  }
  return cachedHelpService;
}

async function handleGetFolderPath(): Promise<string | null> {
  const HelpService = await getHelpService();
  return HelpService.getHelpFolderPath();
}

function handleMarkTerminal(terminalId: string): void {
  getAgentAvailabilityStore().markAsHelp(terminalId);
}

function handleUnmarkTerminal(terminalId: string): void {
  getAgentAvailabilityStore().unmarkAsHelp(terminalId);
}

export const helpNamespace = defineIpcNamespace({
  name: "help",
  ops: {
    getFolderPath: op(HELP_METHOD_CHANNELS.getFolderPath, handleGetFolderPath),
    markTerminal: op(HELP_METHOD_CHANNELS.markTerminal, handleMarkTerminal),
    unmarkTerminal: op(HELP_METHOD_CHANNELS.unmarkTerminal, handleUnmarkTerminal),
  },
});

export function registerHelpHandlers(): () => void {
  return helpNamespace.register();
}
