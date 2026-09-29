import { useEffect } from "react";
import { startRendererMemoryMonitor } from "@/utils/performance";
import { startLongTaskMonitor } from "@/utils/longTaskMonitor";
import { startLayoutShiftMonitor } from "@/utils/layoutShiftMonitor";
import { startPluginMetricsReporter } from "@/services/plugin/pluginMetricsReporter";

export function usePerformanceMonitors() {
  useEffect(() => {
    const stopMonitor = startRendererMemoryMonitor();
    const stopLongTaskMonitor = startLongTaskMonitor();
    const stopLayoutShiftMonitor = startLayoutShiftMonitor();
    const stopPluginMetricsReporter = startPluginMetricsReporter();
    return () => {
      stopMonitor();
      stopLongTaskMonitor();
      stopLayoutShiftMonitor();
      stopPluginMetricsReporter();
    };
  }, []);
}
