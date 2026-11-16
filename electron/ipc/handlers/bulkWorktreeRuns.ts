import { webContents as electronWebContents } from "electron";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { typedBroadcastToLocalViews } from "../utils.js";
import { AppError } from "../../utils/errorTypes.js";
import { isWebContentsFrozen, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { BulkWorktreeRunRegistry } from "../../services/BulkWorktreeRunRegistry.js";
import type {
  BulkWorktreeRunCommandResult,
  BulkWorktreeRunSnapshot,
} from "../../../shared/types/ipc/bulkWorktreeRuns.js";
import { BULK_WORKTREE_RUNS_METHOD_CHANNELS } from "./bulkWorktreeRuns.preload.js";

/**
 * Bulk worktree creation runs (#17085), held here for every local view. Only
 * the view a run executes in publishes it; any view can read, cancel or retry.
 * Remote views run their batches against their own machine, so this is local
 * only.
 */

const text = (max: number) => z.string().max(max);

const ItemSchema = z.object({
  number: z.number().int().nonnegative(),
  title: text(1024),
  stage: z.enum([
    "pending",
    "worktree-creating",
    "worktree-created",
    "terminals-spawning",
    "terminals-error",
    "worktree-error",
    "assigning",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  attempt: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative().optional(),
  error: text(4096).optional(),
  failedStep: z.enum(["worktree", "terminals", "verification", "assignment"]).optional(),
  worktreeId: text(4096).optional(),
  worktreePath: text(4096).optional(),
  branch: text(1024).optional(),
});

const SnapshotSchema = z.object({
  runId: z.string().min(1).max(128),
  projectId: text(512),
  mode: z.enum(["issue", "pr"]),
  phase: z.enum(["running", "cancelling", "cancelled", "done"]),
  // Far past any selection a person makes; a run the ledger refused would go
  // on unseen and unheld.
  items: z.array(ItemSchema).max(5000),
  startedAt: z.number(),
  executions: z
    .array(z.object({ startedAt: z.number(), endedAt: z.number().optional() }))
    .max(1000)
    .optional(),
  updatedAt: z.number(),
  controllable: z.boolean(),
});

const CommandSchema = z.object({
  runId: z.string().min(1).max(128),
  kind: z.enum(["cancel", "retry-failed"]),
});

let registry: BulkWorktreeRunRegistry | null = null;
const watchedOwners = new Set<number>();

function getRegistry(): BulkWorktreeRunRegistry {
  registry ??= new BulkWorktreeRunRegistry({
    broadcast: (runs) => typedBroadcastToLocalViews(CHANNELS.BULK_WORKTREE_RUNS_CHANGED, { runs }),
    sendCommand: (ownerId, command) => {
      const wc = electronWebContents.fromId(ownerId);
      if (!wc || wc.isDestroyed()) return false;
      // A finished run's view may have been frozen since; a retry has to run
      // there now, not whenever the user next comes back to it.
      if (isWebContentsFrozen(wc)) void unfreezeWebContents(wc);
      try {
        wc.send(CHANNELS.BULK_WORKTREE_RUNS_COMMANDED, command);
        return true;
      } catch {
        return false;
      }
    },
  });
  return registry;
}

/**
 * Its runs end with the document that ran them: a reload or a crash leaves a
 * new document in the same view that knows nothing of them.
 */
function watchOwner(wc: Electron.WebContents): void {
  if (watchedOwners.has(wc.id)) return;
  const id = wc.id;
  watchedOwners.add(id);
  const gone = () => registry?.ownerGone(id);
  const onNavigate = () => gone();
  const onProcessGone = () => gone();
  wc.on("did-navigate", onNavigate);
  wc.on("render-process-gone", onProcessGone);
  onWebContentsDestroyed(wc, () => {
    watchedOwners.delete(id);
    gone();
  });
}

function requireLocalView(ctx: IpcContext): Electron.WebContents {
  const wc = ctx.endpoint.kind === "local-view" ? ctx.event?.sender : undefined;
  if (!wc || wc.isDestroyed()) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Only a local project view runs a bulk worktree creation",
    });
  }
  return wc;
}

function handlePublish(ctx: IpcContext, snapshot: BulkWorktreeRunSnapshot): void {
  const wc = requireLocalView(ctx);
  if (!ctx.projectId) {
    throw new AppError({ code: "VALIDATION", message: "A bulk run needs its view's project" });
  }
  watchOwner(wc);
  getRegistry().publish(wc.id, ctx.projectId, snapshot);
}

export const bulkWorktreeRunsNamespace = defineIpcNamespace({
  name: "bulkWorktreeRuns",
  ops: {
    publish: opValidated(
      BULK_WORKTREE_RUNS_METHOD_CHANNELS.publish,
      SnapshotSchema,
      handlePublish,
      {
        withContext: true,
      }
    ),
    list: op(
      BULK_WORKTREE_RUNS_METHOD_CHANNELS.list,
      (): BulkWorktreeRunSnapshot[] => registry?.list() ?? []
    ),
    command: opValidated(
      BULK_WORKTREE_RUNS_METHOD_CHANNELS.command,
      CommandSchema,
      (command): BulkWorktreeRunCommandResult =>
        registry?.command(command) ?? { accepted: false, reason: "not-found" }
    ),
    dismiss: opValidated(
      BULK_WORKTREE_RUNS_METHOD_CHANNELS.dismiss,
      z.string().min(1).max(128),
      (runId): boolean => registry?.dismiss(runId) ?? false
    ),
  },
});

export function registerBulkWorktreeRunsHandlers(): () => void {
  const off = bulkWorktreeRunsNamespace.register();
  return () => {
    off();
    registry?.dispose();
    registry = null;
  };
}
