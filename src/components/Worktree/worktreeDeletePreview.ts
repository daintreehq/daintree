import { worktreeClient } from "@/clients";
import type { WorktreeChanges } from "@shared/types/git";
import type { WorktreeTeardownPreview } from "@shared/types/worktree";
import {
  summarizeWorktreeChanges,
  WorktreeDeletePreviewError,
  type WorktreeDeletePreview,
  type WorktreeSubmoduleRiskState,
} from "@shared/utils/worktreeDeletePreview";

export * from "@shared/utils/worktreeDeletePreview";

/**
 * Force a fresh `git status` for the worktree and return its delete preview.
 *
 * Rejects if the fresh fetch fails or times out — callers MUST fail closed on
 * rejection (escalate the tier / warn), never silently fall back to the stale
 * cached snapshot, which would recreate the exact bug being fixed. Resolves
 * `null` only when the worktree's monitor no longer exists (already removed),
 * which callers may treat as "nothing to gate".
 */
export async function buildWorktreeDeletePreview(
  worktreeId: string
): Promise<WorktreeDeletePreview | null> {
  // Both fetches start together — the submodule inventory walks module
  // directories and is the slower of the two, and serialising them would add
  // its latency to a dialog the user is already waiting in front of.
  //
  // The submodule arm settles to `unverified` instead of rejecting: the
  // parent's status is what the fail-closed contract above is about, and
  // letting a submodule inventory failure reject the whole preview would turn
  // a partial answer into no answer, which is strictly less safe.
  const submodulePromise: Promise<WorktreeSubmoduleRiskState> = worktreeClient
    .getSubmoduleDeleteRisk(worktreeId)
    .then((risk) =>
      risk === null || risk.incomplete
        ? ({ status: "unverified", risk } as const)
        : ({ status: "verified", risk } as const)
    )
    .catch(() => ({ status: "unverified", risk: null }) as const);
  let fresh: WorktreeChanges | null;
  try {
    fresh = await worktreeClient.getFreshChanges(worktreeId);
  } catch (error) {
    // The two arms are independent, so a parent failure must not throw the
    // submodule answer away. It used to: the rejection propagated before the
    // settled submodule arm was ever read, and the dialog then rendered its
    // generic "couldn't verify" warning over an inventory that had completed
    // and found nested files. A force delete from that state destroys content
    // the D2 preview never showed, which is the one thing this module exists
    // to prevent. Carried on the error so the parent arm keeps rejecting and
    // callers keep their existing fail-closed branch.
    throw new WorktreeDeletePreviewError(await submodulePromise, error);
  }
  if (!fresh) {
    // Monitor gone — the worktree is already removed, so there is nothing left
    // to gate. Await the settled submodule arm anyway so it can never surface
    // as an unhandled rejection.
    await submodulePromise;
    return null;
  }
  const changes = fresh.changes ?? [];
  return {
    ...summarizeWorktreeChanges(changes),
    changes,
    rootPath: fresh.rootPath,
    ...(fresh.ahead === undefined ? {} : { ahead: fresh.ahead }),
    submodules: await submodulePromise,
  };
}

/**
 * The teardown a delete would run, or `"unreadable"` when it couldn't be
 * read. Never rejects: a confirm surface has to say an unreadable teardown
 * may still run rather than drop it. `null` when the worktree is gone.
 */
export async function fetchWorktreeTeardownPreview(
  worktreeId: string
): Promise<WorktreeTeardownPreview | null | "unreadable"> {
  try {
    return await worktreeClient.getDeleteTeardownPreview(worktreeId);
  } catch {
    return "unreadable";
  }
}
