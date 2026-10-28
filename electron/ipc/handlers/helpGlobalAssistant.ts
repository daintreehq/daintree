import { AppError } from "../../utils/errorTypes.js";
import type { IpcContext } from "../types.js";
import type {
  GlobalAssistantAttachment,
  GlobalAssistantView,
} from "../../../shared/types/ipc/help.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import type { GlobalAssistantService } from "../../services/GlobalAssistantService.js";
import { getGlobalAssistantService } from "../../services/globalAssistant.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";

/**
 * The global assistant's window-facing surface (#14159). Every call is made by
 * a window; none can name another window's attachment, and none returns the
 * session's credentials. Attaching to a session that is not running is
 * allowed — the panel shows the empty state and asks to start it.
 */

/**
 * The state with the exact subject a view watches the run by. The PTY's launch
 * generation, not the lifecycle's, is what the terminal watch checks.
 */
export function globalAssistantView(service: GlobalAssistantService): GlobalAssistantView {
  const state = service.getState();
  const incarnation =
    state.phase === "running" && state.terminalId
      ? (getPtyClient()?.getLiveGeneration(state.terminalId) ?? null)
      : null;
  return {
    ...state,
    subject:
      state.terminalId && incarnation !== null
        ? {
            hostId: LOCAL_HOST_ID,
            scope: { kind: "global" },
            terminalId: state.terminalId,
            incarnation,
          }
        : null,
  };
}

const published = new WeakSet<GlobalAssistantService>();

/**
 * The service, with every change of it told to the windows: who holds input
 * moves under a window without it asking, and it must hear so at once.
 */
function service(): GlobalAssistantService {
  const instance = getGlobalAssistantService();
  if (!published.has(instance)) {
    published.add(instance);
    const publish = () =>
      broadcastToRenderer(CHANNELS.HELP_GLOBAL_ASSISTANT_CHANGED, globalAssistantView(instance));
    instance.onChange(publish);
    // A PTY host recovery respawns the run's terminal under a new launch
    // generation with no lifecycle change: the subject a view watches moves.
    getPtyClient()?.on("spawn-result", (id: string) => {
      if (id === instance.getState().terminalId) publish();
    });
  }
  return instance;
}

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

export async function handleEnsureGlobalAssistant(ctx: IpcContext): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  await instance.ensureSession();
  return globalAssistantView(instance);
}

export async function handleGetGlobalAssistantState(): Promise<GlobalAssistantView> {
  return globalAssistantView(service());
}

export async function handleAttachGlobalAssistant(
  ctx: IpcContext
): Promise<GlobalAssistantAttachment> {
  const { webContentsId, windowId } = requireWindow(ctx);
  const instance = service();
  const attachmentId = instance.attach(webContentsId, windowId);
  return { attachmentId, state: globalAssistantView(instance) };
}

export async function handleDetachGlobalAssistant(
  ctx: IpcContext,
  attachmentId: string
): Promise<void> {
  const { webContentsId } = requireWindow(ctx);
  service().detach(requireId(attachmentId), webContentsId);
}

export async function handleClaimGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantView> {
  const { webContentsId } = requireWindow(ctx);
  const instance = service();
  instance.claimInput(requireId(attachmentId), webContentsId);
  return globalAssistantView(instance);
}

export async function handleReleaseGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantView> {
  const { webContentsId } = requireWindow(ctx);
  const instance = service();
  instance.releaseInput(requireId(attachmentId), webContentsId);
  return globalAssistantView(instance);
}

/**
 * A confirmation names the run it was asked about: one answered after that run
 * was already replaced must not end its successor.
 */
function requireGeneration(instance: GlobalAssistantService, expected: unknown): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected)) {
    throw new AppError({ code: "VALIDATION", message: "Invalid generation" });
  }
  if (instance.getState().generation !== expected) {
    throw new AppError({
      code: "STALE_GENERATION",
      message: "The global assistant changed since this was asked",
      userMessage: "The global assistant changed since you asked. Nothing was stopped.",
    });
  }
}

export async function handleRestartGlobalAssistant(
  ctx: IpcContext,
  expectedGeneration?: number
): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  requireGeneration(instance, expectedGeneration);
  await instance.restart();
  return globalAssistantView(instance);
}

export async function handleDiscardGlobalAssistant(
  ctx: IpcContext,
  expectedGeneration?: number
): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  requireGeneration(instance, expectedGeneration);
  await instance.discard();
  return globalAssistantView(instance);
}
