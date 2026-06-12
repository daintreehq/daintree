import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store";

// The dock component is lazy-loaded behind a first-open gate (AppLayout), so
// the error watcher that auto-opens it must live in an always-mounted owner:
// inside the dock it can never fire before the first manual open.
export function useDiagnosticsAutoOpen(): void {
  const errorCount = useErrorStore((state) => state.errors.filter((e) => !e.dismissed).length);
  const { isOpen, activeTab, openDock } = useDiagnosticsStore(
    useShallow((s) => ({ isOpen: s.isOpen, activeTab: s.activeTab, openDock: s.openDock }))
  );
  const prevErrorCountRef = useRef(0);

  useEffect(() => {
    if (errorCount > 0 && prevErrorCountRef.current === 0 && !isOpen) {
      openDock("problems");
      useErrorStore.getState().promoteErrors();
    }
    // Promote new errors arriving while the dock is already open on problems
    if (
      errorCount > prevErrorCountRef.current &&
      prevErrorCountRef.current > 0 &&
      isOpen &&
      activeTab === "problems"
    ) {
      useErrorStore.getState().promoteErrors();
    }
    prevErrorCountRef.current = errorCount;
  }, [errorCount, isOpen, openDock, activeTab]);
}
