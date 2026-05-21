import { defineIpcNamespace, op } from "../define.js";
import { HELP_METHOD_CHANNELS } from "./help.preload.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import type * as HelpSessionServiceModule from "../../services/HelpSessionService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import type { ActionContext } from "../../../shared/types/actions.js";

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
  input: {
    projectId: string;
    projectPath: string;
    agentId: string;
    /**
     * Renderer `ActionContext` snapshot captured synchronously when the
     * user launched the assistant. Bound to the MCP session so pinned tool
     * dispatch targets the worktree/terminal focused at launch (#8317).
     */
    context?: ActionContext;
  }
): Promise<{
  sessionId: string;
  sessionPath: string;
  token: string;
  tier: HelpAssistantTier;
  mcpUrl: string | null;
  windowId: number;
} | null> {
  if (!ctx.senderWindow) {
    console.warn("[help] provisionSession invoked without a senderWindow — skipping");
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.provisionSession({
    projectId: input.projectId,
    projectPath: input.projectPath,
    agentId: input.agentId,
    windowId: ctx.senderWindow.id,
    projectViewWebContentsId: ctx.webContentsId,
    actionContext: input.context,
  });
}

async function handleRevokeSession(sessionId: string): Promise<void> {
  const { helpSessionService } = await getHelpSessionService();
  await helpSessionService.revokeSession(sessionId);
}

async function handleTakePendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<{
  agentId: string;
  agentSessionId: string;
  cwd: string;
} | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  // Derive the calling project from the renderer's webContents binding and
  // refuse cross-project pulls. Pending entries hold an agent's resume token
  // — leaking another project's token across processes would let a
  // compromised renderer continue a stranger's conversation. The renderer
  // still passes its projectId (for shape parity with the rest of the
  // namespace), but it must match the view-mapped id or we drop the call.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] takePendingHibernation: projectId mismatch — refusing cross-project pull",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.takePendingHibernation(projectId);
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
    takePendingHibernation: op(
      HELP_METHOD_CHANNELS.takePendingHibernation,
      handleTakePendingHibernation,
      { withContext: true }
    ),
  },
});

export function registerHelpHandlers(): () => void {
  return helpNamespace.register();
}
