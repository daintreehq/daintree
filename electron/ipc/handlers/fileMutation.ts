import { shell } from "electron";
import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import type { IpcContext } from "../types.js";
import { remoteCallerHoldsRoot } from "./files.js";
import {
  discardFileChanges,
  previewDiscard,
  previewTrash,
  trashFile,
} from "../../services/git/fileMutation.js";
import type { FileMutationPreview } from "../../../shared/types/fileMutation.js";
import { invalidateStagingDiffStatCache } from "../../utils/git.js";
import {
  FILES_TRASH_METHOD_CHANNELS,
  GIT_DISCARD_METHOD_CHANNELS,
} from "./fileMutation.preload.js";

const fileMutationPayloadSchema = z.object({
  worktreePath: z.string().min(1),
  relativePath: z.string().min(1),
});

const fileDiscardPayloadSchema = fileMutationPayloadSchema.extend({
  expectedToken: z.string().min(1).optional(),
});

const fileMutationPreviewPayloadSchema = fileMutationPayloadSchema.extend({
  kind: z.enum(["discard", "trash"]),
});

async function requireHeldRoot(ctx: IpcContext, worktreePath: string): Promise<void> {
  if (!(await remoteCallerHoldsRoot(ctx, worktreePath))) {
    throw new Error("Worktree is outside the calling view's project");
  }
}

const trashItem = (absolutePath: string) => shell.trashItem(absolutePath);

/**
 * The two destructive file-row operations (#13424). Each acts on one file of
 * one worktree; the confirm that names the file lives on the renderer actions
 * (`git.discardFileChanges`, `file.trash`) that are this channel's only
 * callers.
 */
export function registerFileMutationHandlers(): () => void {
  const gitDiscard = defineIpcNamespace({
    name: "gitDiscard",
    ops: {
      discardFileChanges: opValidated(
        GIT_DISCARD_METHOD_CHANNELS.discardFileChanges,
        fileDiscardPayloadSchema,
        async (ctx, payload): Promise<void> => {
          checkRateLimit(GIT_DISCARD_METHOD_CHANNELS.discardFileChanges, 10, 10_000);
          await requireHeldRoot(ctx, payload.worktreePath);
          try {
            await discardFileChanges(
              payload.worktreePath,
              payload.relativePath,
              trashItem,
              payload.expectedToken
            );
          } finally {
            // A discard that failed partway may still have moved the index.
            invalidateStagingDiffStatCache(payload.worktreePath);
          }
        },
        { withContext: true }
      ),
      // What the confirm shows before either mutation runs: read-only, so it
      // isn't rate-limited with them, but held to the same worktree.
      previewFileMutation: opValidated(
        GIT_DISCARD_METHOD_CHANNELS.previewFileMutation,
        fileMutationPreviewPayloadSchema,
        async (ctx, payload): Promise<FileMutationPreview> => {
          await requireHeldRoot(ctx, payload.worktreePath);
          return payload.kind === "discard"
            ? previewDiscard(payload.worktreePath, payload.relativePath)
            : previewTrash(payload.worktreePath, payload.relativePath);
        },
        { withContext: true }
      ),
    },
  });

  const filesTrash = defineIpcNamespace({
    name: "filesTrash",
    ops: {
      trash: opValidated(
        FILES_TRASH_METHOD_CHANNELS.trash,
        fileMutationPayloadSchema,
        async (ctx, payload): Promise<void> => {
          checkRateLimit(FILES_TRASH_METHOD_CHANNELS.trash, 10, 10_000);
          await requireHeldRoot(ctx, payload.worktreePath);
          await trashFile(payload.worktreePath, payload.relativePath, trashItem);
          invalidateStagingDiffStatCache(payload.worktreePath);
        },
        { withContext: true }
      ),
    },
  });

  const disposers = [gitDiscard.register(), filesTrash.register()];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
