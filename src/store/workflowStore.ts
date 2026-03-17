import { create } from "zustand";
import type { WorkflowRunIpc } from "@shared/types/ipc/api";

const MAX_RUNS = 20;

interface WorkflowState {
  runs: Map<string, WorkflowRunIpc>;
  isInitialized: boolean;
  epoch: number;

  init: () => Promise<void>;
  refreshRun: (runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  reset: () => void;
}

function trimRuns(runs: Map<string, WorkflowRunIpc>): Map<string, WorkflowRunIpc> {
  if (runs.size <= MAX_RUNS) return runs;
  const active = [...runs.entries()].filter(([, r]) => r.status === "running");
  const inactive = [...runs.entries()]
    .filter(([, r]) => r.status !== "running")
    .sort((a, b) => b[1].startedAt - a[1].startedAt);
  const kept = [...active, ...inactive.slice(0, MAX_RUNS - active.length)];
  return new Map(kept);
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runs: new Map(),
  isInitialized: false,
  epoch: 0,

  init: async () => {
    if (!window.electron?.workflow) return;
    const epoch = get().epoch;
    try {
      const allRuns = await window.electron.workflow.listRuns();
      if (get().epoch !== epoch) return;
      const map = new Map(allRuns.map((r) => [r.runId, r]));
      set({ runs: trimRuns(map), isInitialized: true });
    } catch {
      if (get().epoch !== epoch) return;
      set({ isInitialized: true });
    }
  },

  refreshRun: async (runId: string) => {
    if (!window.electron?.workflow) return;
    const epoch = get().epoch;
    try {
      const run = await window.electron.workflow.getWorkflowRun(runId);
      if (get().epoch !== epoch) return;
      const next = new Map(get().runs);
      if (run) {
        next.set(runId, run);
      } else {
        next.delete(runId);
      }
      set({ runs: trimRuns(next) });
    } catch {
      // Silently ignore fetch errors
    }
  },

  cancelRun: async (runId: string) => {
    if (!window.electron?.workflow) return;
    try {
      await window.electron.workflow.cancelWorkflow(runId);
    } catch {
      // Cancel may fail if already completed
    }
  },

  reset: () => {
    set((state) => ({
      runs: new Map(),
      isInitialized: false,
      epoch: state.epoch + 1,
    }));
  },
}));
