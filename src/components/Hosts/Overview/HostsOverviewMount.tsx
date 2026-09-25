import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";

const LazyHostsOverviewHost = lazy(() =>
  import("./HostsOverviewHost").then((m) => ({ default: m.HostsOverviewHost }))
);

/**
 * The per-view home of the hosts overview and the host summary feed behind
 * it. Where Remote Hosts can't exist its chunk is never loaded.
 */
export function HostsOverviewMount() {
  if (!isRemoteHostsSupported()) return null;
  return (
    <ErrorBoundary variant="component" componentName="HostsOverviewHost">
      <Suspense fallback={null}>
        <LazyHostsOverviewHost />
      </Suspense>
    </ErrorBoundary>
  );
}
