import { defineIpcNamespace, op } from "../define.js";
import { HELP_METHOD_CHANNELS } from "./help.preload.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import type * as HelpSessionServiceModule from "../../services/HelpSessionService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";

let cachedHelpService: typeof HelpServiceModule | null = null;
async function getHelpService(): Promise<typeof HelpServiceModule> {
  if (!cachedHelpService) {
    cachedHelpService = await import("../../services/HelpService.js");
  }
  return cachedHelpService;
}

let cachedHelpSessionService: typeof HelpSessionServiceModule | null = null;
async function getHelpSessionService(): Promise<typeof HelpSessionServiceModule> {
  if (!cachedHelpSessionService) {
    cachedHelpSessionService = await import("../../services/HelpSessionService.js");
  }
  return cachedHelpSessionService;
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

async function handleProvisionSession(
  ctx: import("../types.js").IpcContext,
  input: { projectId: string; projectPath: string }
): Promise<{
  sessionId: string;
  sessionPath: string;
  token: string;
  tier: HelpAssistantTier;
} | null> {
  if (!ctx.senderWindow) {
    console.warn("[help] provisionSession invoked without a senderWindow — skipping");
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.provisionSession({
    projectId: input.projectId,
    projectPath: input.projectPath,
    windowId: ctx.senderWindow.id,
    projectViewWebContentsId: ctx.webContentsId,
  });
}

async function handleRevokeSession(sessionId: string): Promise<void> {
  const { helpSessionService } = await getHelpSessionService();
  await helpSessionService.revokeSession(sessionId);
}

export const helpNamespace = defineIpcNamespace({
  name: "help",
  ops: {
    getFolderPath: op(HELP_METHOD_CHANNELS.getFolderPath, handleGetFolderPath),
    markTerminal: op(HELP_METHOD_CHANNELS.markTerminal, handleMarkTerminal),
    unmarkTerminal: op(HELP_METHOD_CHANNELS.unmarkTerminal, handleUnmarkTerminal),
    provisionSession: op(HELP_METHOD_CHANNELS.provisionSession, handleProvisionSession, {
      withContext: true,
    }),
    revokeSession: op(HELP_METHOD_CHANNELS.revokeSession, handleRevokeSession),
  },
});

export function registerHelpHandlers(): () => void {
  return helpNamespace.register();
}
