import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { retainCrossHostTargetsFor } from "@/components/Fleet/crossHostFleet";
import { useHostList } from "../hostList";
import { startHostMetricsFeed } from "./hostMetricsFeed";
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
 * Follows host summaries for this view (so opted-in hosts' notifications and
 * the overview's sparklines have data) and shows the overview when asked.
 */
export function HostsOverviewHost() {
  const open = useSyncExternalStore(subscribeHostsOverview, isHostsOverviewOpen, () => false);
  useEffect(() => registerHostsOverviewHost(), []);
  useEffect(() => startHostMetricsFeed(), []);
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
