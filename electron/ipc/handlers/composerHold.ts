import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { COMPOSER_HOLD_METHOD_CHANNELS } from "./composerHold.preload.js";
import { AppError } from "../../utils/errorTypes.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import {
  isImageAttachmentPath,
  MAX_SUBMIT_IMAGE_PATHS,
} from "../../../shared/utils/imageAttachmentInput.js";
import type {
  ComposerHoldResult,
  ComposerHoldWithdrawResult,
  HeldComposerSend,
} from "../../../shared/types/ipc/composerHold.js";
import type { NotifyTerminalInfo } from "../../services/mcp-server/terminalNotify.js";

/**
 * A pane composer's sends held while its agent works (#16379). No op takes a
 * project id: main resolves it from the sender's own view, so a view holds
 * and withdraws only for the project it shows.
 */

function requireTerminalId(terminalId: unknown): string {
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new AppError({ code: "VALIDATION", message: "terminalId must be a non-empty string" });
  }
  return terminalId;
}

/**
 * Whether a send now would land mid-turn in an agent not declared to queue
 * it: the only case a send is held. Waiting at any prompt, idle, a shell and
 * a queuing CLI all keep today's immediate send.
 */
export function holdsComposerSend(info: NotifyTerminalInfo | null): info is NotifyTerminalInfo {
  if (info === null) return false;
  if (info.hasPty === false || info.isExited === true) return false;
  if (info.isTrashed === true || info.isClosing === true) return false;
  if (info.detectedAgentId === undefined || info.agentState !== "working") return false;
  return (
    getEffectiveAgentConfig(info.detectedAgentId)?.capabilities?.queuesInputWhileWorking !== true
  );
}

async function handleHold(
  ctx: IpcContext,
  terminalId: string,
  text: string,
  imagePaths?: string[]
): Promise<ComposerHoldResult> {
  const id = requireTerminalId(terminalId);
  if (typeof text !== "string") {
    throw new AppError({ code: "VALIDATION", message: "text must be a string" });
  }
  if (
    imagePaths !== undefined &&
    (!Array.isArray(imagePaths) ||
      imagePaths.length > MAX_SUBMIT_IMAGE_PATHS ||
      !imagePaths.every((path) => typeof path === "string" && isImageAttachmentPath(path)))
  ) {
    throw new AppError({
      code: "VALIDATION",
      message: `imagePaths must be at most ${MAX_SUBMIT_IMAGE_PATHS} absolute local image paths`,
      context: { terminalId: id },
    });
  }
  // Anything that isn't plainly this view's own busy agent is sent as before,
  // and refused there as before.
  const notBusy: ComposerHoldResult = { held: false, reason: "not-busy" };
  const projectId = ctx.projectId;
  const ptyClient = getPtyClient();
  if (!projectId || !ptyClient || ctx.endpoint?.kind === "remote-view") return notBusy;
  if (ptyClient.getTerminalProjectId(id) !== projectId) return notBusy;
  const lease = peekDriveLeaseService();
  if (lease && ctx.endpoint && !lease.isDriving(projectId, ctx.endpoint)) return notBusy;
  const generation = ptyClient.getLiveGeneration(id);
  if (generation === null) return notBusy;
  const info = await ptyClient.getTerminalAsync(id).catch(() => null);
  if (!holdsComposerSend(info)) return notBusy;
  if (info.projectId !== undefined && info.projectId !== projectId) return notBusy;
  const { getComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  const hold = await getComposerSendHold();
  // Read again after the awaits: a restart in between is a run it wasn't for.
  if (ptyClient.getLiveGeneration(id) !== generation) return notBusy;
  const admission = hold.hold({
    terminalId: id,
    projectId,
    generation,
    text,
    imagePaths: imagePaths ?? [],
    info,
  });
  if (admission.ok) return { held: true, send: admission.send };
  return admission.reason === "already-held" ? { held: false, reason: "already-held" } : notBusy;
}

async function handleWithdraw(
  ctx: IpcContext,
  terminalId: string,
  token: string
): Promise<ComposerHoldWithdrawResult> {
  const id = requireTerminalId(terminalId);
  if (typeof token !== "string" || token.length === 0 || token.length > 128) {
    throw new AppError({ code: "VALIDATION", message: "token must be a non-empty string" });
  }
  if (!ctx.projectId) return { withdrawn: false };
  const { peekComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  return { withdrawn: peekComposerSendHold()?.withdraw(id, token, ctx.projectId) ?? false };
}

async function handleList(ctx: IpcContext): Promise<HeldComposerSend[]> {
  if (!ctx.projectId) return [];
  const { peekComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  return peekComposerSendHold()?.list(ctx.projectId) ?? [];
}

export const composerHoldNamespace = defineIpcNamespace({
  name: "composerHold",
  ops: {
    hold: op(COMPOSER_HOLD_METHOD_CHANNELS.hold, handleHold, { withContext: true }),
    withdraw: op(COMPOSER_HOLD_METHOD_CHANNELS.withdraw, handleWithdraw, { withContext: true }),
    list: op(COMPOSER_HOLD_METHOD_CHANNELS.list, handleList, { withContext: true }),
  },
});

export function registerComposerHoldHandlers(): () => void {
  return composerHoldNamespace.register();
}
