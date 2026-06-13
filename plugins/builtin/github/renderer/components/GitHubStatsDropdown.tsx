import { Suspense, lazy, useEffect, useState } from "react";
import type { ForgeStatsDropdownProps } from "@/components/Layout/forgeStatsDropdownContract";
import { GitHubResourceListSkeleton, CommitListSkeleton } from "./GitHubDropdownSkeletons";
import { useGitHubFilterStore } from "../stores/githubFilterStore";

// The list bodies stay in their own chunks — this wrapper is registered (and
// therefore bundled) at app start, but the heavy Virtuoso-backed lists load
// lazily. The idle-time preload below mirrors the old toolbar's eager import
// so a first click after launch usually hits a warm chunk.
const importResourceList = () => import("./GitHubResourceList");
const importCommitList = () => import("./CommitList");

const LazyResourceList = lazy(() =>
  importResourceList().then((m) => ({ default: m.GitHubResourceList }))
);
const LazyCommitList = lazy(() => importCommitList().then((m) => ({ default: m.CommitList })));

type ResourceListType = typeof import("./GitHubResourceList").GitHubResourceList;
type CommitListType = typeof import("./CommitList").CommitList;

if (typeof window !== "undefined") {
  const preload = () => {
    void importResourceList();
    void importCommitList();
  };
  if (typeof window.requestIdleCallback === "function") {
    // Cap the idle wait: under sustained main-thread load (launch hydration,
    // Electron IPC bursts) an untimed idle callback can be deferred for
    // seconds, so a first click would still hit the Suspense skeleton. The
    // timeout forces the preload to run within 2s regardless.
    window.requestIdleCallback(preload, { timeout: 2000 });
  } else {
    window.setTimeout(preload, 2000);
  }
}

/**
 * GitHub's contribution to the host's toolbar stats dropdown slot
 * (`github.statsDropdown`). The host owns the pills, badge, dropdown shell,
 * and freshness/rate-limit chrome; this view supplies the list content for
 * all three kinds.
 *
 * Two-tier loading: lazy()/Suspense covers the cold-click case (click before
 * the idle preload finishes), AND the concrete component reference is
 * eagerly resolved on mount so any subsequent render skips the Suspense
 * boundary — React.lazy suspends on the first render of its boundary even
 * when the import promise has already resolved, which would flash the
 * skeleton over rows that are already cached.
 */
export function GitHubStatsDropdown({
  kind,
  projectPath,
  open,
  worktreePath,
  branch,
  initialCount,
  onClose,
  onFreshFetch,
  onCountUpdate,
}: ForgeStatsDropdownProps) {
  const [ResourceList, setResourceList] = useState<ResourceListType | null>(null);
  const [CommitList, setCommitList] = useState<CommitListType | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (kind === "commits") {
      void importCommitList().then((m) => {
        if (!cancelled) setCommitList(() => m.CommitList);
      });
    } else {
      void importResourceList().then((m) => {
        if (!cancelled) setResourceList(() => m.GitHubResourceList);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [kind]);

  // Reset the search query when the host closes this dropdown (the view stays
  // mounted behind a hidden Activity boundary, so unmount never fires). The
  // filter/sort selections intentionally persist across opens; only the typed
  // search is transient.
  const setIssueSearchQuery = useGitHubFilterStore((s) => s.setIssueSearchQuery);
  const setPrSearchQuery = useGitHubFilterStore((s) => s.setPrSearchQuery);
  useEffect(() => {
    if (open) return;
    if (kind === "issues") setIssueSearchQuery("");
    if (kind === "prs") setPrSearchQuery("");
  }, [open, kind, setIssueSearchQuery, setPrSearchQuery]);

  if (kind === "commits") {
    const commitProps = {
      projectPath: worktreePath ?? projectPath,
      branch,
      onClose,
      initialCount: initialCount ?? undefined,
    };
    return CommitList ? (
      <CommitList {...commitProps} />
    ) : (
      <Suspense fallback={<CommitListSkeleton count={initialCount} immediate />}>
        <LazyCommitList {...commitProps} />
      </Suspense>
    );
  }

  const type = kind === "issues" ? ("issue" as const) : ("pr" as const);
  const listProps = {
    type,
    projectPath,
    onClose,
    initialCount,
    onFreshFetch,
    onCountUpdate,
  };
  return ResourceList ? (
    <ResourceList {...listProps} />
  ) : (
    <Suspense fallback={<GitHubResourceListSkeleton count={initialCount} immediate type={type} />}>
      <LazyResourceList {...listProps} />
    </Suspense>
  );
}
