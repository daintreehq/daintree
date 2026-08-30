import { useEffect, useState } from "react";
import type { ForgeStatsDropdownProps } from "@/components/Layout/forgeStatsDropdownContract";
import { retryableImport } from "@/lib/retryableImport";
import { GitHubResourceListSkeleton, CommitListSkeleton } from "./GitHubDropdownSkeletons";
import { useGitHubFilterStore } from "../stores/githubFilterStore";

// The list bodies stay in their own chunks — this wrapper is registered (and
// therefore bundled) at app start, but the heavy Virtuoso-backed lists load
// only when the dropdown opens. `retryableImport`, not `lazy`: a lazy component
// caches its rejection forever, so one missed chunk fetch would disable the
// dropdown for the whole session with no way back.
const loadResourceList = retryableImport(() =>
  import("./GitHubResourceList").then((m) => m.GitHubResourceList)
);
const loadCommitList = retryableImport(() => import("./CommitList").then((m) => m.CommitList));

type ResourceListType = typeof import("./GitHubResourceList").GitHubResourceList;
type CommitListType = typeof import("./CommitList").CommitList;

/**
 * GitHub's contribution to the host's toolbar stats dropdown slot
 * (`github.statsDropdown`). The host owns the pills, badge, dropdown shell,
 * and freshness/rate-limit chrome; this view supplies the list content for
 * all three kinds.
 *
 * The list chunk loads on first open behind a skeleton; the resolved component
 * is retained (in the loader and in state) so later opens render it straight
 * away. A failed load re-throws in render for the slot's ErrorBoundary, whose
 * Try again remounts this view and re-issues the import.
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
  const [ResourceList, setResourceList] = useState<ResourceListType | null>(() =>
    loadResourceList.peek()
  );
  const [CommitList, setCommitList] = useState<CommitListType | null>(() => loadCommitList.peek());
  const [loadError, setLoadError] = useState<Error | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fail = (err: unknown) => {
      if (!cancelled) setLoadError(err instanceof Error ? err : new Error(String(err)));
    };
    if (kind === "commits") {
      void loadCommitList().then((m) => {
        if (!cancelled) setCommitList(() => m);
      }, fail);
    } else {
      void loadResourceList().then((m) => {
        if (!cancelled) setResourceList(() => m);
      }, fail);
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

  // Surfaced to the slot's ErrorBoundary rather than swallowed: a chunk that
  // never arrives would otherwise leave the skeleton pulsing forever.
  if (loadError) throw loadError;

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
      <CommitListSkeleton count={initialCount} immediate />
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
    <GitHubResourceListSkeleton count={initialCount} immediate type={type} />
  );
}
