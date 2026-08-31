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

function describeUnsuccessfulFetch(result: WorkspaceFetchResult): string {
  if (result.status === "failed") return "Could not fetch from the remote.";
  switch (result.skipReason) {
    case "auth-suspended":
      return "Fetch skipped — authentication to the remote is failing.";
    case "no-common-dir":
      return "Fetch skipped — this path is no longer a git worktree.";
    case "stale-generation":
      return "Fetch cancelled — the worktree was closed while it was running.";
    default:
      return "Fetch skipped — the remote was recently unreachable.";
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
            throw new GitOperationError("unknown", "Some remotes could not be reached.", {
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
