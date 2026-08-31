import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { WorkspaceFetchResult } from "../../../shared/types/workspace-host.js";
import type { GitOperationReason } from "../../../shared/types/ipc/errors.js";
import { validateCwd } from "../../utils/hardenedGit.js";
import { GitOperationError } from "../../utils/errorTypes.js";
import { GIT_FETCH_METHOD_CHANNELS } from "./gitFetch.preload.js";

/**
 * A skip carries no git error of its own, so map the reason we do have onto the
 * closest classification the renderer already knows how to present.
 */
function skipReason(skip: WorkspaceFetchResult["skipReason"]): GitOperationReason {
  return skip === "auth-suspended" ? "auth-failed" : "unknown";
}

/**
 * Every branch describes what was OBSERVED, never a cause we did not see.
 * `no-common-dir` is any failure to resolve the repository, not proof the path
 * stopped being a worktree; a skip is a skip, not a diagnosis of the remote.
 */
function describeUnsuccessfulFetch(result: WorkspaceFetchResult): string {
  if (result.status === "failed") return "Could not fetch from the remote.";
  switch (result.skipReason) {
    case "auth-suspended":
      return "Fetch skipped — authentication to the remote is failing.";
    case "no-common-dir":
      return "Fetch skipped — could not resolve this worktree's repository.";
    case "stale-generation":
      return "Fetch cancelled before it ran.";
    default:
      return "Fetch skipped — a recent attempt on this repository failed.";
  }
}

const fetchPayloadSchema = z.object({
  cwd: z.string().min(1),
  /**
   * Omitted means prune, matching the coordinator default every scheduled fetch
   * has used since #6564. The "Fetch" row sends `false` explicitly; "Fetch and
   * prune" sends `true`.
   */
  prune: z.boolean().optional(),
});

/**
 * User-triggered `git fetch` (#12091).
 *
 * Deliberately NOT implemented like its neighbours in `git-write.ts`, which run
 * `simple-git` directly in the main process. Fetch has to go through the
 * workspace host's `RepoFetchCoordinator`, because linked worktrees share
 * `.git/objects`, `refs/remotes` and `packed-refs`: a second, uncoordinated
 * fetch path would race the background one on `packed-refs.lock`, and would
 * skip the post-fetch status refresh that is the entire point of the feature —
 * refreshing the behind-counts on the card.
 */
export function registerGitFetchHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "gitFetch",
    ops: {
      fetch: opValidated(
        GIT_FETCH_METHOD_CHANNELS.fetch,
        fetchPayloadSchema,
        async (payload): Promise<void> => {
          checkRateLimit(GIT_FETCH_METHOD_CHANNELS.fetch, 20, 10_000);
          validateCwd(payload.cwd);

          const service = deps.worktreeService;
          if (!service) {
            throw new Error("Workspace service unavailable");
          }

          const result = await service.fetchWorktree(payload.cwd, payload.prune !== false);

          // Resolve ONLY on a real success. Anything else means the refs on
          // screen are as stale as they were before the click, and reporting
          // that as done is the one answer the user cannot act on. The message
          // is plain prose: `GitOperationError.reason` is serialized as
          // `gitReason` and the preload re-encodes the `[GitError|…]` prefix
          // from it, so writing the prefix here would double it.
          if (result.status !== "success") {
            throw new GitOperationError(
              result.reason ?? skipReason(result.skipReason),
              describeUnsuccessfulFetch(result),
              { cwd: payload.cwd, op: "fetch" }
            );
          }
          // The coordinator answers for the primary remote alone. On a fork
          // layout the base ref and the branch's own upstream live on two
          // different remotes, and a manual fetch that refreshed one of them is
          // a partial refresh — say so rather than let half-stale counts read
          // as freshly confirmed.
          if (result.auxiliaryFailed === true) {
            throw new GitOperationError("unknown", "Some remotes failed to fetch.", {
              cwd: payload.cwd,
              op: "fetch",
            });
          }
        }
      ),
    },
  });

  return namespace.register();
}
