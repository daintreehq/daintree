import { z } from "zod";
import type {
  MergedWorktreeCleanupAckReceiptsPayload,
  MergedWorktreeCleanupPreview,
  MergedWorktreeCleanupPreviewPayload,
  MergedWorktreeCleanupSetEnabledPayload,
  MergedWorktreeRemovalReceipt,
} from "../../../shared/types/mergedWorktreeCleanup.js";
import { AppError } from "../../utils/errorTypes.js";
import { getShownAppWebContents } from "../../window/webContentsRegistry.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { getIpcDispatcher } from "../dispatcher.js";
import type { IpcContext } from "../types.js";
import { MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS } from "./mergedWorktreeCleanup.preload.js";

const ProjectIdSchema = z.string().min(1).max(200);
const PreviewSchema = z.object({ projectId: ProjectIdSchema }).strict();
const SetEnabledSchema = z.object({ projectId: ProjectIdSchema, enabled: z.boolean() }).strict();
const AckReceiptsSchema = z.object({ ids: z.array(z.string().min(1).max(200)).max(1000) }).strict();

async function service() {
  const { getMergedWorktreeCleanupService } =
    await import("../../services/mergedWorktreeCleanup/mergedWorktreeCleanupLive.js");
  return getMergedWorktreeCleanupService();
}

// The receipts are this machine's removals, filed by this machine's own views:
// not a remote view, and not a local window bound to another host.
function requireLocalView(ctx: IpcContext): void {
  if (
    ctx.endpoint?.kind === "remote-view" ||
    getIpcDispatcher().hostForSender(ctx.webContentsId) !== null
  ) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "mergedWorktreeCleanup: receipts are for this machine's own windows",
    });
  }
}

/**
 * The merged-worktree rule (#17321). Only Project Settings turns it on or
 * off; nothing here removes a worktree, which only the service's own sweep
 * does. Not an action, so it is never on the MCP surface.
 */
export const mergedWorktreeCleanupNamespace = defineIpcNamespace({
  name: "mergedWorktreeCleanup",
  ops: {
    preview: opValidated(
      MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS.preview,
      PreviewSchema,
      async (payload: MergedWorktreeCleanupPreviewPayload): Promise<MergedWorktreeCleanupPreview> =>
        (await service()).preview(payload.projectId)
    ),
    setEnabled: opValidated(
      MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS.setEnabled,
      SetEnabledSchema,
      async (payload: MergedWorktreeCleanupSetEnabledPayload): Promise<void> =>
        (await service()).setEnabled(payload.projectId, payload.enabled)
    ),
    // A view on screen takes them, files them in its inbox, then acks; a view
    // out of sight would file them where nobody looks.
    takeReceipts: op(
      MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS.takeReceipts,
      async (ctx: IpcContext): Promise<MergedWorktreeRemovalReceipt[]> => {
        requireLocalView(ctx);
        if (!getShownAppWebContents().some((contents) => contents.id === ctx.webContentsId)) {
          return [];
        }
        return (await service()).takeReceipts(ctx.webContentsId);
      },
      { withContext: true }
    ),
    ackReceipts: opValidated(
      MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS.ackReceipts,
      AckReceiptsSchema,
      async (ctx: IpcContext, payload: MergedWorktreeCleanupAckReceiptsPayload): Promise<void> => {
        requireLocalView(ctx);
        (await service()).ackReceipts(payload.ids);
      },
      { withContext: true }
    ),
  },
});

export function registerMergedWorktreeCleanupHandlers(): () => void {
  return mergedWorktreeCleanupNamespace.register();
}
