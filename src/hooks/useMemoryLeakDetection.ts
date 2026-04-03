import { useEffect, useRef } from "react";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { useTerminalStore } from "@/store/terminalStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "@/hooks/useElectron";
import { DEFAULT_AUTO_RESTART_THRESHOLD_MB } from "@/store/memoryLeakConfigStore";

export const MEMORY_HISTORY_SIZE = 30;
export const STARTUP_SKIP_SAMPLES = 30;
export const CONSECUTIVE_REQUIRED = 20;
export const MIN_MEMORY_KB = 512_000; // 500 MB
export const MIN_SLOPE_KB_PER_SAMPLE = 137; // ~200 MB/hour at 2.5s intervals
export const PLATEAU_WINDOW = 5;
export const PLATEAU_RANGE_THRESHOLD_KB = MIN_SLOPE_KB_PER_SAMPLE * PLATEAU_WINDOW;
export const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 minutes

export interface LeakState {
  sampleCount: number;
  memHistory: number[];
  consecutiveIncreases: number;
  lastAlertAt: number;
  dismissed: boolean;
}

export function computeSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumI = 0;
  let sumY = 0;
  let sumIY = 0;
  let sumI2 = 0;
  for (let i = 0; i < n; i++) {
    sumI += i;
    sumY += values[i];
    sumIY += i * values[i];
    sumI2 += i * i;
  }
  const denom = n * sumI2 - sumI * sumI;
  if (denom === 0) return 0;
  return (n * sumIY - sumI * sumY) / denom;
}

export function isPlateau(values: number[]): boolean {
  if (values.length < PLATEAU_WINDOW) return false;
  const win = values.slice(-PLATEAU_WINDOW);
  const min = Math.min(...win);
  const max = Math.max(...win);
  return max - min < PLATEAU_RANGE_THRESHOLD_KB;
}

export function evaluateTerminal(memoryKb: number, state: LeakState, now: number): boolean {
  state.sampleCount++;
  state.memHistory = [...state.memHistory, memoryKb].slice(-MEMORY_HISTORY_SIZE);

  if (state.sampleCount < STARTUP_SKIP_SAMPLES) return false;
  if (state.dismissed) return false;
  if (memoryKb < MIN_MEMORY_KB) {
    state.consecutiveIncreases = 0;
    return false;
  }

  if (isPlateau(state.memHistory)) {
    state.consecutiveIncreases = 0;
    return false;
  }

  const prev = state.memHistory[state.memHistory.length - 2];
  if (prev !== undefined && memoryKb > prev) {
    state.consecutiveIncreases++;
  } else {
    state.consecutiveIncreases = 0;
  }

  if (state.consecutiveIncreases >= CONSECUTIVE_REQUIRED) {
    const slope = computeSlope(state.memHistory);
    if (slope >= MIN_SLOPE_KB_PER_SAMPLE) {
      if (now - state.lastAlertAt >= ALERT_COOLDOWN_MS) {
        return true;
      }
    }
  }

  return false;
}

function formatMb(kb: number): string {
  return `${Math.round(kb / 1024)} MB`;
}

function formatGrowthRate(slopeKbPerSample: number): string {
  const mbPerHour = (slopeKbPerSample / 1024) * (3600 / 2.5);
  return `${Math.round(mbPerHour)} MB/hr`;
}

export function createLeakState(): LeakState {
  return {
    sampleCount: 0,
    memHistory: [],
    consecutiveIncreases: 0,
    lastAlertAt: 0,
    dismissed: false,
  };
}

let hookMounted = false;

export function useMemoryLeakDetection(
  enabled: boolean,
  autoRestartThresholdMb: number = DEFAULT_AUTO_RESTART_THRESHOLD_MB
): void {
  const stateMapRef = useRef<Map<string, LeakState>>(new Map());

  useEffect(() => {
    if (!isElectronAvailable() || !enabled || hookMounted) return;
    hookMounted = true;

    const autoRestartThresholdKb = autoRestartThresholdMb * 1024;
    const localStateMap = stateMapRef.current;

    const unsubscribe = useResourceMonitoringStore.subscribe((curr, prev) => {
      if (curr.metrics === prev.metrics) return;

      const now = Date.now();
      const stateMap = localStateMap;

      // Clean up states for removed terminals
      for (const id of stateMap.keys()) {
        if (!curr.metrics.has(id)) {
          stateMap.delete(id);
        }
      }

      for (const [id, metric] of curr.metrics) {
        let leakState = stateMap.get(id);
        if (!leakState) {
          leakState = createLeakState();
          stateMap.set(id, leakState);
        }

        const shouldAlert = evaluateTerminal(metric.memoryKb, leakState, now);

        if (shouldAlert) {
          leakState.lastAlertAt = now;

          const terminal = useTerminalStore.getState().terminalsById[id];
          const terminalTitle = terminal?.title ?? id;
          const slope = computeSlope(leakState.memHistory);

          notify({
            type: "warning",
            priority: "high",
            duration: 0,
            title: `Memory leak detected \u2014 ${terminalTitle}`,
            message: `RSS: ${formatMb(metric.memoryKb)} (growing ${formatGrowthRate(slope)})`,
            inboxMessage: `Memory leak: ${terminalTitle} at ${formatMb(metric.memoryKb)}, growing ${formatGrowthRate(slope)}`,
            correlationId: `memory-leak-${id}`,
            actions: [
              {
                label: "Restart",
                actionId: "terminal.restart" as const,
                actionArgs: { terminalId: id },
                onClick: () => {
                  useTerminalStore.getState().restartTerminal(id);
                },
              },
              {
                label: "Settings",
                actionId: "app.settings.openTab" as const,
                actionArgs: { tab: "terminal", subtab: "performance" },
                onClick: () => {},
              },
              {
                label: "Dismiss",
                variant: "secondary" as const,
                onClick: () => {
                  const st = localStateMap.get(id);
                  if (st) st.dismissed = true;
                },
              },
            ],
          });
        }

        // Auto-restart: if RSS exceeds threshold and the terminal is not waiting for user input
        if (
          autoRestartThresholdKb > 0 &&
          metric.memoryKb > autoRestartThresholdKb &&
          leakState.sampleCount >= STARTUP_SKIP_SAMPLES &&
          !leakState.dismissed
        ) {
          const terminal = useTerminalStore.getState().terminalsById[id];
          if (terminal && terminal.agentState !== "waiting" && !terminal.isInputLocked) {
            leakState.dismissed = true;
            useTerminalStore.getState().restartTerminal(id);
            notify({
              type: "info",
              priority: "high",
              duration: 5000,
              title: `Auto-restarted \u2014 ${terminal.title}`,
              message: `RSS exceeded ${autoRestartThresholdMb.toLocaleString()} MB threshold`,
              inboxMessage: `Auto-restarted ${terminal.title}: RSS exceeded ${autoRestartThresholdMb.toLocaleString()} MB`,
              correlationId: `memory-leak-${id}`,
            });
          }
        }
      }
    });

    return () => {
      unsubscribe();
      hookMounted = false;
      localStateMap.clear();
    };
  }, [enabled, autoRestartThresholdMb]);
}
