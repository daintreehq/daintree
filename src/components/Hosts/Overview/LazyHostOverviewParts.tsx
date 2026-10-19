import { lazy, Suspense, type ComponentProps, type ComponentType } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { hasRemoteHosts, useHostList } from "../hostList";
import type { HostSparkline as HostSparklineComponent } from "./HostSparkline";
import type { OtherHostsWorktrees as OtherHostsWorktreesComponent } from "./OtherHostsWorktrees";
import type { WorktreePlacementRow as WorktreePlacementRowComponent } from "./WorktreePlacementRow";

type PlacementProps = ComponentProps<typeof WorktreePlacementRowComponent>;
type OtherWorktreesProps = ComponentProps<typeof OtherHostsWorktreesComponent>;
type SparklineProps = ComponentProps<typeof HostSparklineComponent>;

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

function loadHostSparkline(): Promise<{ default: ComponentType<SparklineProps> }> {
  if (__DAINTREE_REMOTE_HOSTS__) {
    return import("./HostSparkline").then((m) => ({ default: m.HostSparkline }));
  }
  return Promise.resolve({ default: (_props: SparklineProps) => null });
}

const PlacementRow = lazy(loadPlacementRow);
const Sparkline = lazy(loadHostSparkline);
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

/**
 * A host's sparkline outside the overview (the host switcher). While it loads,
 * an empty box of the same size holds its place so the row doesn't shift.
 */
export function LazyHostSparkline(props: SparklineProps) {
  return (
    <ErrorBoundary variant="component" componentName="HostSparkline">
      <Suspense fallback={<span className={props.className} aria-hidden="true" />}>
        <Sparkline {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
