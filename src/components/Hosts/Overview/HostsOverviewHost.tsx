import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { retainCrossHostTargetsFor } from "@/components/Fleet/crossHostFleet";
import { useHostList } from "../hostList";
import { startHostAttentionFeed } from "./hostMetricsFeed";
import {
  closeHostsOverview,
  isHostsOverviewOpen,
  registerHostsOverviewHost,
  subscribeHostsOverview,
} from "./hostsOverviewRequests";

const LazyHostsOverviewDialog = lazy(() =>
  import("./HostsOverviewDialog").then((m) => ({ default: m.HostsOverviewDialog }))
);

/**
 * Presents opted-in hosts' notifications in this view and shows the overview
 * when asked. The overview follows host summaries itself, only while open.
 */
export function HostsOverviewHost() {
  const open = useSyncExternalStore(subscribeHostsOverview, isHostsOverviewOpen, () => false);
  useEffect(() => registerHostsOverviewHost(), []);
  useEffect(() => startHostAttentionFeed(), []);
  const hostList = useHostList();
  useEffect(() => {
    // A forgotten host's agents leave this window's fleet with it.
    retainCrossHostTargetsFor(new Set(hostList.hosts.map((entry) => entry.descriptor.id)));
  }, [hostList.hosts]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyHostsOverviewDialog onClose={closeHostsOverview} />
    </Suspense>
  );
}
