import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { COMPOSER_HOLD_METHOD_CHANNELS } from "./composerHold.preload.js";
import { AppError } from "../../utils/errorTypes.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { composerSendHoldCause } from "../../../shared/utils/terminalWakeGate.js";
import {
  isImageAttachmentPath,
  MAX_SUBMIT_IMAGE_PATHS,
} from "../../../shared/utils/imageAttachmentInput.js";
import type {
  ComposerHoldResult,
  ComposerHoldSendNowResult,
  ComposerHoldWithdrawResult,
  HeldComposerSend,
} from "../../../shared/types/ipc/composerHold.js";
import type { NotifyTerminalInfo } from "../../services/mcp-server/terminalNotify.js";

/**
 * A pane composer's sends held while its pane has no line to take them
 * (#16379, #16872). No op takes a project id: main resolves it from the
 * sender's own view, so a view holds and withdraws only for the project it
 * shows.
 */

function requireTerminalId(terminalId: unknown): string {
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new AppError({ code: "VALIDATION", message: "terminalId must be a non-empty string" });
  }
  return terminalId;
}

function requireToken(token: unknown): string {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) {
    throw new AppError({ code: "VALIDATION", message: "token must be a non-empty string" });
  }
  return token;
}

/**
 * Whether a send now would have nowhere to go (#16872): a choice dialog on
 * screen, or a turn in a CLI known to take down its input line. The only
 * cases a send is held; every other pane keeps today's immediate send.
 */
export function holdsComposerSend(info: NotifyTerminalInfo | null): info is NotifyTerminalInfo {
  return info !== null && composerSendHoldCause(info) !== null;
}

/** Whether `ctx`'s screen drives `projectId`, read now: a lease can move at any time. */
function drivesProject(ctx: IpcContext, projectId: string): boolean {
  const lease = peekDriveLeaseService();
  return !lease || !ctx.endpoint || lease.isDriving(projectId, ctx.endpoint);
}

export async function handleHold(
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
  // Anything that isn't plainly this view's own pane with no line to take the
  // send is sent as before, and refused there as before.
  const notBusy: ComposerHoldResult = { held: false, reason: "not-busy" };
  const projectId = ctx.projectId;
  const ptyClient = getPtyClient();
  if (!projectId || !ptyClient || ctx.endpoint?.kind === "remote-view") return notBusy;
  if (ptyClient.getTerminalProjectId(id) !== projectId) return notBusy;
  if (!drivesProject(ctx, projectId)) return notBusy;
  const generation = ptyClient.getLiveGeneration(id);
  if (generation === null) return notBusy;
  const info = await ptyClient.getTerminalAsync(id).catch(() => null);
  // A restart during the read started a run this wasn't written for, and a
  // read that failed says nothing about whether sending now is safe: neither
  // is held nor sent.
  const unavailable: ComposerHoldResult = { held: false, reason: "unavailable" };
  if (info === null || ptyClient.getLiveGeneration(id) !== generation) return unavailable;
  if (!holdsComposerSend(info)) return notBusy;
  if (info.projectId !== undefined && info.projectId !== projectId) return notBusy;
  const { getComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  const hold = await getComposerSendHold();
  if (ptyClient.getLiveGeneration(id) !== generation) return unavailable;
  if (!drivesProject(ctx, projectId)) return notBusy;
  const admission = hold.hold({
    terminalId: id,
    projectId,
    generation,
    text,
    imagePaths: imagePaths ?? [],
    info,
    authorize: () => drivesProject(ctx, projectId),
  });
  if (admission.ok) return { held: true, send: admission.send };
  return { held: false, reason: admission.reason };
}

async function handleWithdraw(
  ctx: IpcContext,
  terminalId: string,
  token: string
): Promise<ComposerHoldWithdrawResult> {
  const id = requireTerminalId(terminalId);
  requireToken(token);
  const projectId = ctx.projectId;
  if (!projectId) return { withdrawn: false };
  const { peekComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  // Only the screen driving the project takes back what is waiting for its prompt.
  if (!drivesProject(ctx, projectId)) return { withdrawn: false };
  return { withdrawn: peekComposerSendHold()?.withdraw(id, token, projectId) ?? false };
}

/**
 * Type a held send now, whatever its pane was last seen doing (#16745).
 * `inputBlocked` is the asking view's own word that its panel can't take
 * input: it can only stop the send, never start one.
 */
export async function handleSendNow(
  ctx: IpcContext,
  terminalId: string,
  token: string,
  inputBlocked?: boolean
): Promise<ComposerHoldSendNowResult> {
  const id = requireTerminalId(terminalId);
  const held = requireToken(token);
  if (inputBlocked !== undefined && typeof inputBlocked !== "boolean") {
    throw new AppError({ code: "VALIDATION", message: "inputBlocked must be a boolean" });
  }
  const notHeld: ComposerHoldSendNowResult = { outcome: "not-held" };
  const projectId = ctx.projectId;
  // A remote view never holds a send: its own sends go as before.
  if (!projectId || ctx.endpoint?.kind === "remote-view") return notHeld;
  const { peekComposerSendHold } =
    await import("../../services/composerHold/composerSendHoldLive.js");
  const hold = peekComposerSendHold();
  if (hold === null) return notHeld;
  return hold.sendNow({
    terminalId: id,
    token: held,
    projectId,
    inputBlocked: inputBlocked === true,
    authorize: () => drivesProject(ctx, projectId),
  });
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
    sendNow: op(COMPOSER_HOLD_METHOD_CHANNELS.sendNow, handleSendNow, { withContext: true }),
    list: op(COMPOSER_HOLD_METHOD_CHANNELS.list, handleList, { withContext: true }),
  },
});

export function registerComposerHoldHandlers(): () => void {
  return composerHoldNamespace.register();
}
