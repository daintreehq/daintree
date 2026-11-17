import { useEffect, useRef } from "react";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { isElectronAvailable } from "@/hooks/useElectron";
import { terminalClient } from "@/clients/terminalClient";
import { clientErrorText } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { SpawnResult } from "@shared/types/pty-host";

export function buildLeakActions(terminalId: string, muteAlerts: () => void) {
  return [
    {
      label: "Restart terminal",
      actionId: "terminal.restart" as const,
      actionArgs: { terminalId },
      onClick: () => {
        usePanelStore.getState().restartTerminal(terminalId);
      },
    },
    {
      label: "Settings",
      actionId: "app.settings.openTab" as const,
      actionArgs: { tab: "terminal", subtab: "performance" },
      onClick: openPerformanceSettings,
    },
    {
      label: "Mute alerts",
      variant: "secondary" as const,
      onClick: muteAlerts,
    },
  ];
}

export function openPerformanceSettings(): void {
  void actionService.dispatch(
    "app.settings.openTab",
    { tab: "terminal", subtab: "performance" },
    { source: "user" }
  );
}

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
    sumY += values[i]!;
    sumIY += i * values[i]!;
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

export function useMemoryLeakDetection(enabled: boolean): void {
  const stateMapRef = useRef<Map<string, LeakState>>(new Map());

  useEffect(() => {
    if (!isElectronAvailable() || !enabled || hookMounted) return;
    hookMounted = true;

    const localStateMap = stateMapRef.current;

    const unsubscribe = useResourceMonitoringStore.subscribe((curr, prev) => {
      const stateMap = localStateMap;

      if (curr.metrics !== prev.metrics) {
        for (const id of stateMap.keys()) {
          if (!curr.metrics.has(id)) {
            stateMap.delete(id);
          }
        }
      }

      if (curr.lastBatch === prev.lastBatch || curr.lastBatch === null) return;

      const now = Date.now();
      // Only the terminals this poll sampled: each PTY host shard polls on its
      // own, and counting another shard's poll as a repeat of this terminal's
      // last reading resets its growth streak (#17194).
      for (const [id, sample] of Object.entries(curr.lastBatch.samples)) {
        let leakState = stateMap.get(id);
        if (!leakState) {
          leakState = createLeakState();
          stateMap.set(id, leakState);
        }

        const shouldAlert = evaluateTerminal(sample.memoryKb, leakState, now);

        if (shouldAlert) {
          leakState.lastAlertAt = now;

          const terminal = usePanelStore.getState().panelsById[id];
          const terminalTitle = terminal?.title ?? id;
          const slope = computeSlope(leakState.memHistory);

          notify({
            type: "warning",
            priority: "high",
            duration: 0,
            title: `Memory leak detected \u2014 ${terminalTitle}`,
            message: `RSS: ${formatMb(sample.memoryKb)} (growing ${formatGrowthRate(slope)})`,
            inboxMessage: `Memory leak: ${terminalTitle} at ${formatMb(sample.memoryKb)}, growing ${formatGrowthRate(slope)}`,
            correlationId: `memory-leak-${id}`,
            context: {
              panelId: id,
              ...(terminal?.worktreeId ? { worktreeId: terminal.worktreeId } : {}),
            },
            actions: buildLeakActions(id, () => {
              const st = localStateMap.get(id);
              if (st) st.dismissed = true;
            }),
          });
        }
      }
    });

    return () => {
      unsubscribe();
      hookMounted = false;
      localStateMap.clear();
    };
  }, [enabled]);

  useEffect(() => {
    if (!isElectronAvailable()) return;
    return window.electron.events.on("terminal:memory-leak-restart-requested", (request) => {
      void handleMemoryLeakRestartRequest(request);
    });
  }, []);
}

/**
 * How long the host's answer to the replacement spawn is waited for once the
 * restart has dispatched it. Main reports a host that never answers at 30s
 * (#12754), so this only backs that up.
 */
export const SPAWN_ANSWER_WAIT_MS = 35_000;

type RestartOutcome =
  | { kind: "restarted" }
  | { kind: "failed"; reason: string }
  | { kind: "skipped" }
  | { kind: "gone" };

/**
 * The host's memory-leak policy picked this view to restart a terminal over its
 * auto-restart threshold (#14703). The host decides once per terminal and asks
 * one view, so this runs the restart the user's own Restart runs, unless the
 * pane is waiting for input or locked against it: the host asks again later.
 *
 * Only a replacement the host confirmed is announced as a restart (#17602). A
 * refused or failed one says so, and points at the pane, whose banner holds its
 * recovery.
 */
export async function handleMemoryLeakRestartRequest(request: {
  terminalId: string;
  thresholdMb: number;
}): Promise<void> {
  const { terminalId, thresholdMb } = request;
  const terminal = usePanelStore.getState().panelsById[terminalId];
  if (!terminal || !isPtyPanel(terminal)) return;
  if (terminal.agentState === "waiting" || terminal.isInputLocked) return;
  // The restart under way reports through the pane, and this one would be
  // refused; it must not take that one's outcome as its own.
  if (terminal.isRestarting) return;

  const restartKey = terminal.restartKey ?? 0;
  const replacing = () => {
    const live = usePanelStore.getState().panelsById[terminalId];
    return live !== undefined && isPtyPanel(live) && (live.restartKey ?? 0) !== restartKey;
  };
  // Armed before the restart: the host's answer can arrive ahead of the
  // spawn's own reply.
  const answer = listenForSpawnAnswer(terminalId, replacing);
  try {
    const outcome = await restartForMemory(terminal, replacing, answer.result);
    reportRestart(terminal, thresholdMb, outcome);
  } finally {
    answer.dispose();
  }
}

async function restartForMemory(
  before: PtyPanelData,
  replacing: () => boolean,
  answer: Promise<SpawnResult>
): Promise<RestartOutcome> {
  try {
    await usePanelStore.getState().restartTerminal(before.id);
  } catch (error) {
    return { kind: "failed", reason: clientErrorText(error, "The restart was interrupted.") };
  }
  const after = usePanelStore.getState().panelsById[before.id];
  if (!after || !isPtyPanel(after) || after.location === "trash") return { kind: "gone" };
  // Only errors this attempt set: one left from an earlier attempt describes that one.
  if (after.restartError && after.restartError !== before.restartError) {
    return { kind: "failed", reason: after.restartError.message };
  }
  if (!replacing()) return { kind: "skipped" };
  if (after.spawnError && after.spawnError !== before.spawnError) {
    return { kind: "failed", reason: after.spawnError.message };
  }
  // `restartTerminal` resolves once the spawn is dispatched; whether a process
  // started is the host's answer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    answer,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SPAWN_ANSWER_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (result === null) {
    return { kind: "failed", reason: "The terminal backend hasn't confirmed a replacement process." };
  }
  if (!result.success) {
    return { kind: "failed", reason: result.error?.message ?? "Failed to start terminal process" };
  }
  return { kind: "restarted" };
}

/** The first spawn answer for the terminal once `counts` holds, until disposed. */
function listenForSpawnAnswer(
  terminalId: string,
  counts: () => boolean
): { result: Promise<SpawnResult>; dispose: () => void } {
  let settle: (result: SpawnResult) => void = () => {};
  const result = new Promise<SpawnResult>((resolve) => {
    settle = resolve;
  });
  let unsubscribe: (() => void) | null = terminalClient.onSpawnResult((id, spawnResult) => {
    if (id !== terminalId || !counts()) return;
    settle(spawnResult);
    dispose();
  });
  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }
  return { result, dispose };
}

function reportRestart(before: PtyPanelData, thresholdMb: number, outcome: RestartOutcome): void {
  if (outcome.kind === "gone") return;
  const terminalId = before.id;
  // Closed while the host answered: there is nothing left to report on.
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel || panel.location === "trash") return;

  // The pane already shows this very failure from the last attempt; the host
  // asks again every minute while the process stays over the threshold.
  if (
    outcome.kind === "failed" &&
    (outcome.reason === before.restartError?.message ||
      outcome.reason === before.spawnError?.message)
  ) {
    logWarn("[MemoryLeak] Auto-restart failed again", { terminalId, reason: outcome.reason });
    return;
  }

  const title = panel.title;
  const threshold = `${thresholdMb.toLocaleString()} MB`;
  const worktreeId = panel.worktreeId;
  const shared = {
    priority: "high" as const,
    correlationId: `memory-leak-${terminalId}`,
    // One standing outcome per terminal: a later one retires a stale failure.
    replaceKey: `memory-leak-restart-${terminalId}`,
    context: { panelId: terminalId, ...(worktreeId ? { worktreeId } : {}) },
  };
  const goToTerminal = {
    label: "Go to terminal",
    actionId: "panel.focus" as const,
    actionArgs: { panelId: terminalId },
    onClick: () =>
      void actionService.dispatch("panel.focus", { panelId: terminalId }, { source: "user" }),
  };

  switch (outcome.kind) {
    case "restarted":
      notify({
        ...shared,
        type: "info",
        duration: 5000,
        title: `Auto-restarted \u2014 ${title}`,
        message: `RSS exceeded ${threshold} threshold`,
        inboxMessage: `Auto-restarted ${title}: RSS exceeded ${threshold}`,
      });
      return;
    case "failed":
      notify({
        ...shared,
        type: "error",
        title: `Couldn't auto-restart \u2014 ${title}`,
        message: `RSS exceeded ${threshold} threshold. ${outcome.reason}`,
        inboxMessage: `Couldn't auto-restart ${title} over ${threshold}: ${outcome.reason}`,
        action: goToTerminal,
      });
      return;
    case "skipped":
      notify({
        ...shared,
        type: "warning",
        title: `Auto-restart skipped \u2014 ${title}`,
        message: `RSS exceeded ${threshold} threshold, but the terminal can't be restarted right now.`,
        inboxMessage: `Auto-restart skipped for ${title}: RSS exceeded ${threshold}`,
        action: goToTerminal,
      });
      return;
  }
}
