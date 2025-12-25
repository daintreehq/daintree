import { useState, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { readXtermVisualMetrics, XtermVisualMetrics } from "../utils/xtermUtils";

export function useTerminalMetrics() {
  const [metrics, setMetrics] = useState<XtermVisualMetrics | null>(null);
  const metricsRef = useRef<XtermVisualMetrics | null>(null);

  const updateMetrics = useCallback((term: Terminal | null) => {
    if (!term) return;
    const m = readXtermVisualMetrics(term);
    if (m) {
      metricsRef.current = m;
      setMetrics(m);
    }
  }, []);

  return { metrics, metricsRef, updateMetrics };
}
