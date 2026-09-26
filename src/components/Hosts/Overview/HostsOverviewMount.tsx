import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteShellSupported } from "@/lib/remoteHosts";

function loadHostsOverviewHost() {
  // Tested directly so a build without Remote Hosts (Windows) drops the overview.
  if (__DAINTREE_REMOTE_HOSTS__) {
    return import("./HostsOverviewHost").then((m) => ({ default: m.HostsOverviewHost }));
  }
  return Promise.resolve({ default: () => null });
}

const LazyHostsOverviewHost = lazy(loadHostsOverviewHost);

/**
 * The per-view home of the hosts overview and the host summary feed behind
 * it. Where Remote Hosts can't exist its chunk is never loaded.
 */
export function HostsOverviewMount() {
  if (!isRemoteShellSupported()) return null;
  return (
    <ErrorBoundary variant="component" componentName="HostsOverviewHost">
      <Suspense fallback={null}>
        <LazyHostsOverviewHost />
      </Suspense>
    </ErrorBoundary>
  );
}
