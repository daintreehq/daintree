import { useEffect } from "react";
import { startRendererMemoryMonitor } from "@/utils/performance";
import { startLongTaskMonitor } from "@/utils/longTaskMonitor";

export function usePerformanceMonitors() {
  useEffect(() => {
    const stopMonitor = startRendererMemoryMonitor();
    const stopLongTaskMonitor = startLongTaskMonitor();
    return () => {
      stopMonitor();
      stopLongTaskMonitor();
    };
  }, []);
}
