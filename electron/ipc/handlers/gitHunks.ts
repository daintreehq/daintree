import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import type { IpcContext } from "../types.js";
import { remoteCallerHoldsRoot } from "./files.js";
import { validateCwd } from "../../utils/hardenedGit.js";
import { invalidateStagingDiffStatCache } from "../../utils/git.js";
import {
  applyReadHunks,
  gitPathFor,
  parseReadHunks,
  type HunkStagingDirection,
} from "../../services/git/hunkStaging.js";
import { GIT_FILE_DIFF_MAX_BYTES } from "../../../shared/config/gitReadLimits.js";
import type { GitHunkStagingResult } from "../../../shared/types/ipc/git.js";
import { GIT_HUNKS_METHOD_CHANNELS } from "./gitHunks.preload.js";

/**
 * A worktree-relative path git could list: no root (a drive, a UNC share or a
 * leading separator of either kind), no climbing out, no NUL.
 */
const relativeGitPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/^[\\/]/.test(value) &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split(/[\\/]+/).includes(".."),
    "Invalid file path"
  );

const hunkStagingPayloadSchema = z.object({
  cwd: z.string().min(1),
  filePath: relativeGitPath,
  // Hunks come from a diff the pane read in one window, so together they fit one.
  hunks: z
    .array(z.string().min(1))
    .min(1)
    .refine(
      (hunks) =>
        hunks.reduce((total, hunk) => total + Buffer.byteLength(hunk, "utf8"), 0) <=
        GIT_FILE_DIFF_MAX_BYTES,
      "Hunks exceed the diff size limit"
    ),
});

type HunkStagingPayload = z.infer<typeof hunkStagingPayloadSchema>;

async function runHunkStaging(
  ctx: IpcContext,
  payload: HunkStagingPayload,
  direction: HunkStagingDirection
): Promise<GitHunkStagingResult> {
  validateCwd(payload.cwd);
  if (!(await remoteCallerHoldsRoot(ctx, payload.cwd))) {
    throw new Error("Worktree is outside the calling view's project");
  }
  const read = parseReadHunks(payload.hunks);
  const gitPath = gitPathFor(payload.filePath);
  try {
    return await applyReadHunks(payload.cwd, gitPath, read, direction);
  } finally {
    invalidateStagingDiffStatCache(payload.cwd);
  }
}

/**
 * Hunk staging for the diff pane (#17331). Routed like `git:stage-file`: a
 * driver write that runs on the host that holds the worktree.
 */
export function registerGitHunkHandlers(): () => void {
  const gitHunks = defineIpcNamespace({
    name: "gitHunks",
    ops: {
      stageHunks: opValidated(
        GIT_HUNKS_METHOD_CHANNELS.stageHunks,
        hunkStagingPayloadSchema,
        async (ctx, payload): Promise<GitHunkStagingResult> => {
          checkRateLimit(GIT_HUNKS_METHOD_CHANNELS.stageHunks, 30, 10_000);
          return runHunkStaging(ctx, payload, "stage");
        },
        { withContext: true }
      ),
      unstageHunks: opValidated(
        GIT_HUNKS_METHOD_CHANNELS.unstageHunks,
        hunkStagingPayloadSchema,
        async (ctx, payload): Promise<GitHunkStagingResult> => {
          checkRateLimit(GIT_HUNKS_METHOD_CHANNELS.unstageHunks, 30, 10_000);
          return runHunkStaging(ctx, payload, "unstage");
        },
        { withContext: true }
      ),
    },
  });
  return gitHunks.register();
}
