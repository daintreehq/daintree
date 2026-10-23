import { create } from "zustand";
import { systemClient } from "@/clients/systemClient";
import { logInfo } from "@/utils/logger";
import type {
  AgentLaunchAdmission,
  AgentLaunchHoldReason,
  AgentLaunchObservation,
} from "@shared/types/agentLaunchAdmission";

/**
 * Launches held before they start: agent panes that have not spawned yet,
 * while the kernel reports critical memory pressure (#13530) or the host
 * already runs as many agents as its memory allows (#14221), and the project
 * this view was asked to open, on pressure alone. Each continues on its own
 * once a poll finds room, or at once when the user goes ahead anyway. Per
 * project view, like the panels it holds; a backgrounded view's holds resume
 * when it runs again. The agent count is the host's, shared by every view.
 */
export const MEMORY_PRESSURE_POLL_MS = 5_000;

export const PROJECT_OPEN_HOLD_KEY = "project-open";

export function panelHoldKey(panelId: string): string {
  return `panel:${panelId}`;
}

/** Why an agent pane waits, and what the host showed when it last looked. */
export interface AgentLaunchHoldDetail {
  reason: AgentLaunchHoldReason;
  observation: AgentLaunchObservation;
}

interface MemoryPressureWaitState {
  /** Agent panes held from spawning, for their pane chrome. */
  heldPanelIds: Record<string, true>;
  /** What each held pane waits on; absent while a released launch is queued. */
  holdDetails: Record<string, AgentLaunchHoldDetail>;
}

export const useMemoryPressureWaitStore = create<MemoryPressureWaitState>(() => ({
  heldPanelIds: {},
  holdDetails: {},
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
  /** An agent pane's launch: it waits on the host's agent count as well as on pressure. */
  panelId?: string;
  /** Why it was held, for an agent pane. */
  detail?: AgentLaunchHoldDetail;
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

/**
 * What a host that can't count its agents reports (one from before #14221, or
 * a failed read): the kernel reading alone, every count unknown.
 */
async function kernelOnlyObservation(): Promise<AgentLaunchObservation> {
  return {
    kernelCritical: await isMemoryPressureCritical(),
    runningAgents: null,
    startingAgents: 0,
    agentLaunchLimit: null,
    memoryTotalBytes: null,
  };
}

/**
 * Ask the host to start one agent launch. A failed ask falls back to the
 * kernel reading, so a missing count never holds a launch.
 */
export async function requestAgentLaunchAdmission(
  terminalId: string
): Promise<AgentLaunchAdmission> {
  try {
    const admission = await systemClient.requestAgentLaunchAdmission(terminalId);
    if (admission && typeof admission === "object" && admission.observation) return admission;
  } catch {
    // An older host has no such check; fall through to the one it has.
  }
  const observation = await kernelOnlyObservation();
  return { holdReason: observation.kernelCritical ? "kernel-critical" : null, observation };
}

async function observeAgentLaunchAdmission(): Promise<AgentLaunchObservation> {
  try {
    const observation = await systemClient.observeAgentLaunchAdmission();
    if (observation && typeof observation === "object") return observation;
  } catch {
    // As above.
  }
  return kernelOnlyObservation();
}

/** Agent launches the host has room for now; unlimited when it can't say. */
function openPlaces(observation: AgentLaunchObservation): number {
  const { runningAgents, startingAgents, agentLaunchLimit } = observation;
  if (runningAgents === null || agentLaunchLimit === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, agentLaunchLimit - runningAgents - startingAgents);
}

function setPanelHeld(panelId: string, held: boolean, detail?: AgentLaunchHoldDetail): void {
  useMemoryPressureWaitStore.setState((state) => {
    const holdDetails = { ...state.holdDetails };
    if (held && detail) holdDetails[panelId] = detail;
    else if (!held) delete holdDetails[panelId];
    const detailsChanged = holdDetails[panelId] !== state.holdDetails[panelId];
    if (held === (state.heldPanelIds[panelId] === true) && !detailsChanged) return state;
    const heldPanelIds = { ...state.heldPanelIds };
    if (held) heldPanelIds[panelId] = true;
    else delete heldPanelIds[panelId];
    return { heldPanelIds, holdDetails };
  });
}

/** A released launch is queued, not waiting: its pane drops the reason it waited for. */
function clearHoldDetail(panelId: string): void {
  useMemoryPressureWaitStore.setState((state) => {
    if (!(panelId in state.holdDetails)) return state;
    const holdDetails = { ...state.holdDetails };
    delete holdDetails[panelId];
    return { holdDetails };
  });
}

/**
 * `resuming` leaves a pane marked held: its launch is queued, not started, and
 * the mark is what keeps a restart off it until the launch clears it itself.
 */
function take(key: string, resuming = false): MemoryPressureHold | undefined {
  const hold = holds.get(key);
  if (!hold) return undefined;
  holds.delete(key);
  if (hold.panelId !== undefined) {
    if (resuming) clearHoldDetail(hold.panelId);
    else setPanelHeld(hold.panelId, false);
  }
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
  const waiting = [...holds].filter(([, hold]) => !hold.isDeferred?.());
  if (waiting.length > 0) {
    const agentsWaiting = waiting.some(([, hold]) => hold.panelId !== undefined);
    const observation = agentsWaiting
      ? await observeAgentLaunchAdmission()
      : await kernelOnlyObservation();
    if (!observation.kernelCritical) {
      // Insertion order, so a restore resumes in the order it was laid out; the
      // startup queue then starts them one at a time as it always does. Agent
      // launches resume only as far as the host has room, and each asks again
      // as it starts, so two views can't both take the last place.
      let places = openPlaces(observation);
      for (const [key, hold] of waiting) {
        if (holds.get(key) !== hold || hold.isDeferred?.()) continue;
        // Gone while the host answered: it gives up its place rather than taking one.
        if (hold.isStale?.()) {
          take(key);
          continue;
        }
        if (hold.panelId === undefined) {
          take(key, true)?.resume(false);
        } else if (places > 0) {
          places -= 1;
          take(key, true)?.resume(false);
        }
      }
    }
    // What still waits shows what the host looks like now.
    for (const [key, hold] of waiting) {
      if (holds.get(key) !== hold || hold.panelId === undefined) continue;
      hold.detail = {
        reason: observation.kernelCritical ? "kernel-critical" : "agent-capacity",
        observation,
      };
      setPanelHeld(hold.panelId, true, hold.detail);
    }
  }
  schedulePoll();
}

/** Hold a launch until the host has room. A second hold under the same key replaces the first. */
export function holdForMemoryPressure(key: string, hold: MemoryPressureHold): void {
  const prior = holds.get(key);
  if (prior && prior !== hold) take(key)?.onCancel?.();
  holds.set(key, hold);
  if (hold.panelId !== undefined) setPanelHeld(hold.panelId, true, hold.detail);
  logInfo("[MemoryPressureWait] Launch held", {
    key,
    reason: hold.detail?.reason ?? "kernel-critical",
  });
  schedulePoll();
}

/** The user's "anyway": continue this one launch now, whatever the pressure or count. */
export function launchDespiteMemoryPressure(key: string): void {
  take(key, true)?.resume(true);
}

/** Called by a resumed launch as it starts, whatever it then does. */
export function clearPanelMemoryPressureMark(panelId: string): void {
  setPanelHeld(panelId, false);
}

export function cancelMemoryPressureHold(key: string): void {
  take(key)?.onCancel?.();
}

export function resetMemoryPressureHoldsForTesting(): void {
  holds.clear();
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  useMemoryPressureWaitStore.setState({ heldPanelIds: {}, holdDetails: {} });
}
