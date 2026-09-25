import { Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { LazyHostFilePickerHost } from "@/lazyPanels";

/**
 * The per-view home of the host picker. Where remote hosts can't exist the
 * picker's chunk is never loaded, so a Windows build fetches nothing extra.
 */
export function HostFilePickerMount() {
  if (!isRemoteHostsSupported()) return null;
  return (
    <ErrorBoundary variant="component" componentName="HostFilePickerHost">
      <Suspense fallback={null}>
        <LazyHostFilePickerHost />
      </Suspense>
    </ErrorBoundary>
  );
}
