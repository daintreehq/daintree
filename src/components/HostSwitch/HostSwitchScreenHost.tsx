import { lazy, Suspense } from "react";
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";

const LazyHostSwitchScreen = lazy(() =>
  import("./HostSwitchScreen").then((m) => ({ default: m.HostSwitchScreen }))
);

/**
 * The window's switch screen while it is on its way to another host. Costs
 * nothing until a switch starts: the store stays empty where Remote Hosts
 * can't exist, and the screen's code loads with the first switch.
 */
export function HostSwitchScreenHost() {
  const pending = usePendingHostSwitchStore((state) => state.pending);
  if (!pending) return null;
  return (
    <Suspense fallback={<div className="fixed inset-0 z-[calc(var(--z-toolbar)+1)]" />}>
      <LazyHostSwitchScreen pending={pending} />
    </Suspense>
  );
}
