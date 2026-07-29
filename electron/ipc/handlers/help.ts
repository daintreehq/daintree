import { shell } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { HELP_METHOD_CHANNELS } from "./help.preload.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import type * as HelpSessionServiceModule from "../../services/HelpSessionService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import type { ActionContext } from "../../../shared/types/actions.js";
import type { PinnedActionContextSnapshot } from "../../../shared/types/ipc/help.js";

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

/**
 * Scaffolds the global assistant content folder (~/.daintree/assistant —
 * README plus the .claude/.agents layout) and opens it in the OS file
 * manager. Returns null when scaffolding failed; otherwise the path plus
 * whether `shell.openPath` actually opened it (a broken file-manager
 * association fails silently apart from its error string), so the renderer
 * can tell the user where the folder is instead of showing nothing.
 */
async function handleOpenAssistantContentFolder(): Promise<{
  path: string;
  opened: boolean;
} | null> {
  const { ensureAssistantContentDir } = await import("../../services/AssistantContentMirror.js");
  let dir: string;
  try {
    dir = await ensureAssistantContentDir();
  } catch (err) {
    console.warn("[help] Failed to prepare the assistant content folder:", err);
    return null;
  }
  const openError = await shell.openPath(dir);
  if (openError) {
    console.warn("[help] Failed to open the assistant content folder:", openError);
  }
  return { path: dir, opened: openError === "" };
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

/**
 * Projects an `ActionContext` onto the narrow, display-only snapshot the
 * HelpPanel footer renders (#8772). Always reads the *active* worktree triple
 * together — `ActionContext` only carries name/branch for the active worktree,
 * so mixing in `focusedWorktreeId` would yield an id that doesn't match the
 * name/branch beside it. The session's tool calls target the active worktree
 * anyway. Returns null when the snapshot carries no identifying target (neither
 * worktree nor terminal), so the chip is suppressed rather than rendered empty.
 */
export function pinnedSnapshotFromContext(
  context: ActionContext | null
): PinnedActionContextSnapshot | null {
  if (!context) return null;
  const worktreeId = context.activeWorktreeId ?? null;
  const worktreeName = context.activeWorktreeName ?? null;
  const worktreeBranch = context.activeWorktreeBranch ?? null;
  const terminalId = context.focusedTerminalId ?? null;
  if (worktreeId === null && terminalId === null) return null;
  return { worktreeId, worktreeName, worktreeBranch, terminalId };
}

async function handleGetPinnedActionContext(
  ctx: import("../types.js").IpcContext,
  sessionId: string
): Promise<PinnedActionContextSnapshot | null> {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const { helpSessionService } = await getHelpSessionService();
  // Per-window pin (#7002): only the renderer that minted the session may
  // read its pinned context. The data is display-only (no token), but
  // refusing cross-window reads keeps the namespace consistent with the rest
  // of the per-view isolation discipline.
  const ownerWebContentsId = helpSessionService.getWebContentsIdForSessionId(sessionId);
  if (ownerWebContentsId !== null && ownerWebContentsId !== ctx.webContentsId) {
    console.warn(
      "[help] getPinnedActionContext: webContents mismatch — refusing cross-window read",
      { fromWebContents: ctx.webContentsId, owner: ownerWebContentsId }
    );
    return null;
  }
  return pinnedSnapshotFromContext(helpSessionService.getActionContextForSessionId(sessionId));
}

async function handleRevokeSession(sessionId: string): Promise<void> {
  const { helpSessionService } = await getHelpSessionService();
  await helpSessionService.revokeSession(sessionId);
}

async function handlePeekPendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<{
  agentId: string;
  agentSessionId: string;
  cwd: string;
  // #10815: in-memory-only flag stamped on eviction capture. Drives the
  // renderer's pull-on-mount cold switch-back auto-resume; disk-loaded
  // prior-session entries lack it (→ false) so app restart never auto-resumes.
  panelWasOpen: boolean;
} | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  // Same cross-project guard as the take handler below: a pending entry holds
  // an agent's resume token, so refuse reads for any project other than the
  // one bound to this renderer's webContents.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] peekPendingHibernation: projectId mismatch — refusing cross-project read",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.peekPendingHibernation(projectId);
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

async function handleRestorePendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<boolean> {
  if (typeof projectId !== "string" || !projectId) return false;
  // Same cross-project guard as the peek/take handlers. The entry itself never
  // crosses the bridge — main restores from its own take-side stash — so this
  // only has to establish that the caller is the view that took it.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] restorePendingHibernation: projectId mismatch — refusing cross-project restore",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return false;
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.restorePendingHibernation(projectId);
}

async function handleReportPanelOpen(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  isOpen: boolean
): Promise<void> {
  if (typeof projectId !== "string" || !projectId) return;
  if (typeof isOpen !== "boolean") return;
  // Same cross-project guard as the hibernation handlers: only the renderer
  // bound to this project's webContents may report its panel state. A
  // mismatched report would let one view's open-state drive another's
  // cold-resume decision (#10815).
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn("[help] reportPanelOpen: projectId mismatch — refusing cross-project report", {
      requested: projectId,
      fromView: ctx.projectId,
      webContentsId: ctx.webContentsId,
    });
    return;
  }
  const { helpSessionService } = await getHelpSessionService();
  helpSessionService.reportPanelOpen(projectId, isOpen);
}

export const helpNamespace = defineIpcNamespace({
  name: "help",
  ops: {
    getFolderPath: op(HELP_METHOD_CHANNELS.getFolderPath, handleGetFolderPath),
    openAssistantContentFolder: op(
      HELP_METHOD_CHANNELS.openAssistantContentFolder,
      handleOpenAssistantContentFolder
    ),
    markTerminal: op(HELP_METHOD_CHANNELS.markTerminal, handleMarkTerminal),
    unmarkTerminal: op(HELP_METHOD_CHANNELS.unmarkTerminal, handleUnmarkTerminal),
    provisionSession: op(HELP_METHOD_CHANNELS.provisionSession, handleProvisionSession, {
      withContext: true,
    }),
    revokeSession: op(HELP_METHOD_CHANNELS.revokeSession, handleRevokeSession),
    getPinnedActionContext: op(
      HELP_METHOD_CHANNELS.getPinnedActionContext,
      handleGetPinnedActionContext,
      { withContext: true }
    ),
    peekPendingHibernation: op(
      HELP_METHOD_CHANNELS.peekPendingHibernation,
      handlePeekPendingHibernation,
      { withContext: true }
    ),
    takePendingHibernation: op(
      HELP_METHOD_CHANNELS.takePendingHibernation,
      handleTakePendingHibernation,
      { withContext: true }
    ),
    restorePendingHibernation: op(
      HELP_METHOD_CHANNELS.restorePendingHibernation,
      handleRestorePendingHibernation,
      { withContext: true }
    ),
    reportPanelOpen: op(HELP_METHOD_CHANNELS.reportPanelOpen, handleReportPanelOpen, {
      withContext: true,
    }),
  },
});

export function registerHelpHandlers(): () => void {
  return helpNamespace.register();
}
