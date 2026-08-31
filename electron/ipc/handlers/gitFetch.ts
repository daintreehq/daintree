import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import { validateCwd } from "../../utils/hardenedGit.js";
import { GitOperationError } from "../../utils/errorTypes.js";
import { GIT_FETCH_METHOD_CHANNELS } from "./gitFetch.preload.js";

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

          // A fetch that ran and failed must surface as a failure, not as a
          // quietly-successful no-op: the counts on the card would then be as
          // stale as before the click, with nothing saying so.
          if (result.status === "failed") {
            throw new GitOperationError(
              result.reason ?? "unknown",
              `[GitError|${result.reason ?? "unknown"}||] Fetch failed`,
              { cwd: payload.cwd, op: "fetch" }
            );
          }
          if (result.status === "skipped" && result.skipReason === "auth-suspended") {
            throw new GitOperationError(
              result.reason ?? "auth-failed",
              `[GitError|${result.reason ?? "auth-failed"}||] Fetch skipped — authentication failed`,
              { cwd: payload.cwd, op: "fetch" }
            );
          }
        }
      ),
    },
  });

  return namespace.register();
}
