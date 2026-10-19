import { create } from "zustand";
import { systemClient } from "@/clients/systemClient";
import { logInfo } from "@/utils/logger";

/**
 * Launches held while the kernel reports critical memory pressure (#13530):
 * agent panes that have not spawned yet, and the project this view was asked
 * to open. Each continues on its own once a poll reads pressure below
 * critical, or at once when the user goes ahead anyway. Per project view, like
 * the panels it holds; a backgrounded view's holds resume when it runs again.
 */
export const MEMORY_PRESSURE_POLL_MS = 5_000;

export const PROJECT_OPEN_HOLD_KEY = "project-open";

export function panelHoldKey(panelId: string): string {
  return `panel:${panelId}`;
}

interface MemoryPressureWaitState {
  /** Agent panes held from spawning, for their pane chrome. */
  heldPanelIds: Record<string, true>;
}

export const useMemoryPressureWaitStore = create<MemoryPressureWaitState>(() => ({
  heldPanelIds: {},
}));

export interface MemoryPressureHold {
  /** Continue the held launch; `anyway` when the user overrode the wait. */
  resume: (anyway: boolean) => void;
  /** True once nothing wants the launch any more (pane removed, superseded). */
  isStale?: () => boolean;
  /** True while the launch should keep waiting whatever the pressure (pane in the trash). */
  isDeferred?: () => boolean;
  /** Runs when the hold ends without the launch continuing. */
  onCancel?: () => void;
  panelId?: string;
}

const holds = new Map<string, MemoryPressureHold>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** False when the check itself fails: a missing reading never holds a launch. */
export async function isMemoryPressureCritical(): Promise<boolean> {
  try {
    return (await systemClient.isMemoryPressureCritical()) === true;
  } catch {
    return false;
  }
}

function setPanelHeld(panelId: string, held: boolean): void {
  useMemoryPressureWaitStore.setState((state) => {
    if (held === (state.heldPanelIds[panelId] === true)) return state;
    const heldPanelIds = { ...state.heldPanelIds };
    if (held) heldPanelIds[panelId] = true;
    else delete heldPanelIds[panelId];
    return { heldPanelIds };
  });
}

function take(key: string): MemoryPressureHold | undefined {
  const hold = holds.get(key);
  if (!hold) return undefined;
  holds.delete(key);
  if (hold.panelId !== undefined) setPanelHeld(hold.panelId, false);
  if (holds.size === 0 && pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  return hold;
}

function schedulePoll(): void {
  if (pollTimer !== null || holds.size === 0) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll();
  }, MEMORY_PRESSURE_POLL_MS);
}

async function poll(): Promise<void> {
  for (const [key, hold] of [...holds]) {
    if (hold.isStale?.()) take(key);
  }
  if (holds.size === 0) return;
  // Nothing to ask main for while every hold is deferred anyway.
  const waiting = [...holds].some(([, hold]) => !hold.isDeferred?.());
  if (waiting && !(await isMemoryPressureCritical())) {
    // Insertion order, so a restore resumes in the order it was laid out; the
    // startup queue then starts them one at a time as it always does.
    for (const [key, hold] of [...holds]) {
      if (holds.get(key) === hold && !hold.isDeferred?.()) take(key)?.resume(false);
    }
  }
  schedulePoll();
}

/** Hold a launch until pressure eases. A second hold under the same key replaces the first. */
export function holdForMemoryPressure(key: string, hold: MemoryPressureHold): void {
  const prior = holds.get(key);
  if (prior && prior !== hold) take(key)?.onCancel?.();
  holds.set(key, hold);
  if (hold.panelId !== undefined) setPanelHeld(hold.panelId, true);
  logInfo("[MemoryPressureWait] Launch held: memory pressure is critical", { key });
  schedulePoll();
}

/** The user's "anyway": continue this one launch now, whatever the pressure. */
export function launchDespiteMemoryPressure(key: string): void {
  take(key)?.resume(true);
}

export function cancelMemoryPressureHold(key: string): void {
  take(key)?.onCancel?.();
}

export function resetMemoryPressureHoldsForTesting(): void {
  holds.clear();
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  useMemoryPressureWaitStore.setState({ heldPanelIds: {} });
}
