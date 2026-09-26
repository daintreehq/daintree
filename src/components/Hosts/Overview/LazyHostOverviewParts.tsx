import { lazy, Suspense, type ComponentProps } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { hasRemoteHosts, useHostList } from "../hostList";
import type { OtherHostsWorktrees as OtherHostsWorktreesComponent } from "./OtherHostsWorktrees";
import type { WorktreePlacementRow as WorktreePlacementRowComponent } from "./WorktreePlacementRow";

type PlacementProps = ComponentProps<typeof WorktreePlacementRowComponent>;
type OtherWorktreesProps = ComponentProps<typeof OtherHostsWorktreesComponent>;

// Each loader tests the define directly so a build without Remote Hosts
// (Windows) drops these components from its output.
function loadPlacementRow() {
  if (__DAINTREE_REMOTE_HOSTS__) {
    return import("./WorktreePlacementRow").then((m) => ({ default: m.WorktreePlacementRow }));
  }
  return Promise.resolve({ default: (_props: PlacementProps) => null });
}

function loadOtherHostsWorktrees() {
  if (__DAINTREE_REMOTE_HOSTS__) {
    return import("./OtherHostsWorktrees").then((m) => ({ default: m.OtherHostsWorktrees }));
  }
  return Promise.resolve({ default: (_props: OtherWorktreesProps) => null });
}

const PlacementRow = lazy(loadPlacementRow);
const OtherWorktrees = lazy(loadOtherHostsWorktrees);

/** Whether another host exists here: until one does, nothing is loaded or shown. */
function useRemoteHostsInUse(): boolean {
  const hostList = useHostList();
  return isRemoteShellSupported() && hasRemoteHosts(hostList);
}

/** The new-worktree dialog's host choice; absent until a host other than this machine exists. */
export function LazyWorktreePlacementRow(props: PlacementProps) {
  if (!useRemoteHostsInUse()) return null;
  return (
    <ErrorBoundary variant="component" componentName="WorktreePlacementRow">
      <Suspense fallback={null}>
        <PlacementRow {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Other hosts' worktrees under the worktree overview; absent until another host exists. */
export function LazyOtherHostsWorktrees(props: OtherWorktreesProps) {
  if (!useRemoteHostsInUse()) return null;
  return (
    <ErrorBoundary variant="component" componentName="OtherHostsWorktrees">
      <Suspense fallback={null}>
        <OtherWorktrees {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
