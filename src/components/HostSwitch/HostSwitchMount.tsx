import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isRemoteShellSupported } from "@/lib/remoteHosts";

const LazyHostSwitchDialogHost = lazy(() =>
  import("./HostSwitchDialogHost").then((m) => ({ default: m.HostSwitchDialogHost }))
);

/**
 * The per-view home of the host switch dialog. Where remote hosts can't
 * exist its chunk is never loaded.
 */
export function HostSwitchMount() {
  if (!isRemoteShellSupported()) return null;
  return (
    <ErrorBoundary variant="component" componentName="HostSwitchDialogHost">
      <Suspense fallback={null}>
        <LazyHostSwitchDialogHost />
      </Suspense>
    </ErrorBoundary>
  );
}
