import { useEffect, useState } from "react";
import { FolderGit2, GitBranch } from "@/components/icons";
import { WorkspaceTile } from "@/components/Pilot/WorkspaceTile";
import type { CanopyItem } from "./canopyModel";
import { ownCanopyApi, type CanopyApi } from "./canopyHostSource";

/**
 * Branches already read, by incarnation, so going back to a row says where it
 * is at once rather than filling in a beat later.
 */
const branches = new Map<string, string | null>();
/** Enough for every run a session looks at; the oldest look goes first. */
const MAX_REMEMBERED = 64;
/** How often the shown branch is read again while nothing else prompts it. */
const REREAD_MS = 15_000;

function remember(key: string, branch: string | null): void {
  branches.delete(key);
  branches.set(key, branch);
  if (branches.size > MAX_REMEMBERED) branches.delete(branches.keys().next().value!);
}

export function __resetCanopyPlaceForTests(): void {
  branches.clear();
}

function useRunBranch(
  hostId: string,
  runId: string,
  spawnedAt: number,
  agentState: string | undefined,
  runBranch: CanopyApi["runBranch"]
) {
  // Run ids mean something only on their own host.
  const key = `${hostId}:${runId}:${spawnedAt}`;
  const [read, setRead] = useState<{ key: string; branch: string | null } | null>(null);
  // Read again as the agent moves on, and now and then while it works: a turn,
  // or the user in another terminal, can check out another branch.
  useEffect(() => {
    let live = true;
    const readBranch = () =>
      runBranch(runId, { spawnedAt }).then(
        (branch) => {
          if (!live) return;
          remember(key, branch);
          setRead({ key, branch });
        },
        () => {
          // Unread is not branchless: the folder is still worth saying, and
          // a branch read before stays until a read replaces it.
          if (live && !branches.has(key)) setRead({ key, branch: null });
        }
      );
    void readBranch();
    const timer = setInterval(readBranch, REREAD_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key, runId, spawnedAt, agentState, runBranch]);
  if (read?.key === key) return { known: true, branch: read.branch };
  return branches.has(key)
    ? { known: true, branch: branches.get(key) ?? null }
    : { known: false, branch: null };
}

/**
 * Where the selected agent is: its project and the branch its folder has
 * checked out, said above the pane so it never has to be read out of the
 * terminal. A folder outside git, or on a detached HEAD, is named by its
 * folder instead.
 */
export function CanopyPlace({
  item,
  id,
  hostId = "",
  runBranch = ownCanopyApi.runBranch,
}: {
  item: CanopyItem;
  id: string;
  /** The host the run is on, when it isn't the window's own. */
  hostId?: string;
  /** Read on the host the run is on: another host's folders mean nothing here. */
  runBranch?: CanopyApi["runBranch"];
}) {
  const { row, workspace } = item;
  const { known, branch } = useRunBranch(
    hostId,
    item.runId,
    row.run.spawnedAt,
    row.run.agentState,
    runBranch
  );
  const fallback = known && branch === null ? row.worktreeLabel : null;

  return (
    <div
      id={id}
      data-canopy-place=""
      className="flex h-9 min-w-0 shrink-0 items-center gap-2 px-1 text-xs select-none"
    >
      <WorkspaceTile group={workspace} />
      <span className="min-w-0 shrink truncate font-medium text-text-primary">
        {workspace.name}
      </span>
      {branch !== null && (
        <span className="flex min-w-0 shrink-[2] items-center gap-1 text-text-secondary">
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="sr-only">on branch</span>
          <span className="truncate font-mono">{branch}</span>
        </span>
      )}
      {fallback !== null && (
        <span className="flex min-w-0 shrink-[2] items-center gap-1 text-text-secondary">
          <FolderGit2 className="size-3 shrink-0" aria-hidden="true" />
          <span className="sr-only">in folder</span>
          <span className="truncate font-mono">{fallback}</span>
        </span>
      )}
    </div>
  );
}
