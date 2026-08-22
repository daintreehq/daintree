import { Suspense, lazy, useEffect, useState } from "react";
import type { ForgeStatsDropdownProps } from "@/components/Layout/forgeStatsDropdownContract";
import { GitHubResourceListSkeleton, CommitListSkeleton } from "./GitHubDropdownSkeletons";
import { useGitHubFilterStore } from "../stores/githubFilterStore";

// The list bodies stay in their own chunks — this wrapper is registered (and
// therefore bundled) at app start, but the heavy Virtuoso-backed lists load
// only when the dropdown opens.
const importResourceList = () => import("./GitHubResourceList");
const importCommitList = () => import("./CommitList");

const LazyResourceList = lazy(() =>
  importResourceList().then((m) => ({ default: m.GitHubResourceList }))
);
const LazyCommitList = lazy(() => importCommitList().then((m) => ({ default: m.CommitList })));

type ResourceListType = typeof import("./GitHubResourceList").GitHubResourceList;
type CommitListType = typeof import("./CommitList").CommitList;

/**
 * GitHub's contribution to the host's toolbar stats dropdown slot
 * (`github.statsDropdown`). The host owns the pills, badge, dropdown shell,
 * and freshness/rate-limit chrome; this view supplies the list content for
 * all three kinds.
 *
 * Two-tier loading: lazy()/Suspense covers the first open, AND the concrete
 * component reference is retained after it resolves so subsequent opens skip
 * the Suspense boundary.
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
    if (!open) return;
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
  }, [kind, open]);

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
