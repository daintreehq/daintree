import { create } from "zustand";

export const PANEL_COUNT = 50;
export const WORKTREE_COUNT = 10;
export const WRITES = 1000;

export interface BenchPanel {
  id: string;
  kind: "terminal";
  title: string;
  location: "grid";
  agentState?: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  activityHeadline?: string;
}

interface BenchPanelState {
  panelsById: Record<string, BenchPanel>;
  panelIds: string[];
  panelIdsByWorktreeId: Record<string, string[]>;
  commandQueueCountById: Record<string, number>;
  focusedId: string | null;
  maximizedId: string | null;
  pingSeq: number;
}

export const benchPanelStore = create<BenchPanelState>(() => ({
  panelsById: {},
  panelIds: [],
  panelIdsByWorktreeId: {},
  commandQueueCountById: {},
  focusedId: null,
  maximizedId: null,
  pingSeq: 0,
}));

export const counters = { isPtyPanel: 0 };

export function countingIsPtyPanel(p: { kind?: string } | null | undefined): boolean {
  counters.isPtyPanel += 1;
  return p?.kind === "terminal";
}

// `withAgents: false` models plain shells — the checklist's worst case, where
// neither agent item can ever complete and both scans run to the end.
export function seedPanels(withAgents: boolean): void {
  const panelsById: Record<string, BenchPanel> = {};
  const panelIds: string[] = [];
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (let i = 0; i < PANEL_COUNT; i++) {
    const id = `panel-${i}`;
    const worktreeId = `/repo/wt-${i % WORKTREE_COUNT}`;
    panelsById[id] = {
      id,
      kind: "terminal",
      title: `Panel ${i}`,
      location: "grid",
      ...(withAgents ? { launchAgentId: "claude", agentState: i < 3 ? "working" : "idle" } : {}),
    };
    panelIds.push(id);
    (panelIdsByWorktreeId[worktreeId] ??= []).push(id);
  }
  benchPanelStore.setState({
    panelsById,
    panelIds,
    panelIdsByWorktreeId,
    commandQueueCountById: {},
    focusedId: null,
    maximizedId: null,
    pingSeq: 0,
  });
}

let seq = 0;

// Mirrors `updateActivity`: one panel object replaced, `panelsById` respread.
export function activityWrites(): void {
  for (let i = 0; i < WRITES; i++) {
    const id = `panel-${i % PANEL_COUNT}`;
    benchPanelStore.setState((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      return {
        panelsById: { ...state.panelsById, [id]: { ...panel, activityHeadline: `step ${++seq}` } },
      };
    });
  }
}

// Focus-slice writes that leave the panel records untouched.
export function focusWrites(): void {
  for (let i = 0; i < WRITES; i++) {
    benchPanelStore.setState((state) => ({
      focusedId: `panel-${i % PANEL_COUNT}`,
      pingSeq: state.pingSeq + 1,
    }));
  }
}

export function measureCalls(run: () => void): number {
  counters.isPtyPanel = 0;
  run();
  return counters.isPtyPanel;
}
