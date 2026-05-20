import { useState, useEffect } from "react";

import { UI_DOHERTY_THRESHOLD, UI_SKELETON_GATE_MS } from "@/lib/animationUtils";

export function useDeferredLoading(isPending: boolean, delay: number): boolean {
  const [showLoader, setShowLoader] = useState(isPending && delay <= 0);

  useEffect(() => {
    if (!isPending) {
      setShowLoader(false);
      return;
    }
    if (delay <= 0) {
      setShowLoader(true);
      return;
    }
    const timer = setTimeout(() => setShowLoader(true), delay);
    return () => clearTimeout(timer);
  }, [isPending, delay]);

  return showLoader;
}

export function useDohertyGate(isPending: boolean): boolean {
  return useDeferredLoading(isPending, UI_DOHERTY_THRESHOLD);
}

export function useSkeletonGate(isPending: boolean): boolean {
  return useDeferredLoading(isPending, UI_SKELETON_GATE_MS);
}
