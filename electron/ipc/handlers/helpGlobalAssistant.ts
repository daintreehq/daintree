import { AppError } from "../../utils/errorTypes.js";
import type { IpcContext } from "../types.js";
import type {
  GlobalAssistantAttachment,
  GlobalAssistantState,
} from "../../../shared/types/ipc/help.js";
import { getGlobalAssistantService } from "../../services/globalAssistant.js";

/**
 * The global assistant's window-facing surface (#14159). Every call is made by
 * a window; none can name another window's attachment, and none returns the
 * session's credentials. Attaching to a session that is not running is
 * allowed — the panel shows the empty state and asks to start it.
 */

function requireWindow(ctx: IpcContext): { webContentsId: number; windowId: number } {
  if (!ctx.senderWindow) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "The global assistant is shown by a window of this machine.",
    });
  }
  return { webContentsId: ctx.webContentsId, windowId: ctx.senderWindow.id };
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new AppError({ code: "VALIDATION", message: "An attachment id is required." });
  }
  return value;
}

export async function handleEnsureGlobalAssistant(ctx: IpcContext): Promise<GlobalAssistantState> {
  requireWindow(ctx);
  return getGlobalAssistantService().ensureSession();
}

export async function handleGetGlobalAssistantState(): Promise<GlobalAssistantState> {
  return getGlobalAssistantService().getState();
}

export async function handleAttachGlobalAssistant(
  ctx: IpcContext
): Promise<GlobalAssistantAttachment> {
  const { webContentsId, windowId } = requireWindow(ctx);
  const service = getGlobalAssistantService();
  const attachmentId = service.attach(webContentsId, windowId);
  return { attachmentId, state: service.getState() };
}

export async function handleDetachGlobalAssistant(
  ctx: IpcContext,
  attachmentId: string
): Promise<void> {
  const { webContentsId } = requireWindow(ctx);
  getGlobalAssistantService().detach(requireId(attachmentId), webContentsId);
}

export async function handleClaimGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantState> {
  const { webContentsId } = requireWindow(ctx);
  const service = getGlobalAssistantService();
  service.claimInput(requireId(attachmentId), webContentsId);
  return service.getState();
}

export async function handleReleaseGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantState> {
  const { webContentsId } = requireWindow(ctx);
  const service = getGlobalAssistantService();
  service.releaseInput(requireId(attachmentId), webContentsId);
  return service.getState();
}

export async function handleRestartGlobalAssistant(ctx: IpcContext): Promise<GlobalAssistantState> {
  requireWindow(ctx);
  return getGlobalAssistantService().restart();
}

export async function handleDiscardGlobalAssistant(ctx: IpcContext): Promise<GlobalAssistantState> {
  requireWindow(ctx);
  const service = getGlobalAssistantService();
  await service.discard();
  return service.getState();
}
