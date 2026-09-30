import { create } from "zustand";
import type {
  TerminalResourceBatchPayload,
  TerminalResourceProcess,
  TerminalResourceSample,
} from "@shared/types/pty-host";

export const CPU_HISTORY_SIZE = 30;

export interface TerminalResourceState {
  cpuPercent: number;
  memoryKb: number;
  cpuHistory: number[];
  breakdown: TerminalResourceProcess[];
  /** Processes in the tree; `breakdown` holds at most ten of them. */
  processCount?: number;
}

interface ResourceMonitoringStore {
  enabled: boolean;
  metrics: Map<string, TerminalResourceState>;
  setEnabled: (enabled: boolean) => void;
  updateMetrics: (batch: TerminalResourceBatchPayload) => void;
  removePanel: (id: string) => void;
  clear: () => void;
}

// How many polls in a row repeated the sample an entry was built from.
const repeatCounts = new WeakMap<TerminalResourceState, number>();

/**
 * Whether this entry's sample has held for a full history window. From here on
 * the store keeps handing out the same entry, so a consumer that counts polls
 * by entry identity must treat it as already past any hysteresis.
 */
export function isSettledResourceState(entry: TerminalResourceState): boolean {
  return (repeatCounts.get(entry) ?? 0) >= CPU_HISTORY_SIZE - 1;
}

function sameBreakdown(a: TerminalResourceProcess[], b: TerminalResourceProcess[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.pid !== y.pid ||
      x.comm !== y.comm ||
      x.cpuPercent !== y.cpuPercent ||
      x.memoryKb !== y.memoryKb
    ) {
      return false;
    }
  }
  return true;
}

function sameSample(entry: TerminalResourceState, sample: TerminalResourceSample): boolean {
  return (
    entry.cpuPercent === sample.cpuPercent &&
    entry.memoryKb === sample.memoryKb &&
    entry.processCount === sample.processCount &&
    sameBreakdown(entry.breakdown, sample.breakdown)
  );
}

export const useResourceMonitoringStore = create<ResourceMonitoringStore>((set) => ({
  enabled: false,
  metrics: new Map(),

  setEnabled: (enabled) =>
    set(() => {
      if (!enabled) {
        return { enabled, metrics: new Map() };
      }
      return { enabled };
    }),

  updateMetrics: (batch) =>
    set((state) => {
      // Always a new Map: the leak detector evaluates every entry once per
      // batch, and its cadence must not depend on whether anything moved.
      const next = new Map(state.metrics);
      for (const [id, sample] of Object.entries(batch)) {
        const existing = next.get(id);
        let repeats = 0;
        if (existing && sameSample(existing, sample)) {
          repeats = (repeatCounts.get(existing) ?? 0) + 1;
          // Held for a full history window, another copy would change nothing
          // a pane shows (see isSettledResourceState) but its identity — and
          // re-render the pane.
          if (repeats >= CPU_HISTORY_SIZE) continue;
        }
        const history = existing?.cpuHistory ?? [];
        const entry: TerminalResourceState = {
          cpuPercent: sample.cpuPercent,
          memoryKb: sample.memoryKb,
          cpuHistory: [...history, sample.cpuPercent].slice(-CPU_HISTORY_SIZE),
          breakdown: sample.breakdown,
          processCount: sample.processCount,
        };
        if (repeats > 0) repeatCounts.set(entry, repeats);
        next.set(id, entry);
      }
      return { metrics: next };
    }),

  removePanel: (id) =>
    set((state) => {
      const next = new Map(state.metrics);
      next.delete(id);
      return { metrics: next };
    }),

  clear: () => set({ metrics: new Map() }),
}));
