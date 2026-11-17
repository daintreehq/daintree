import { useEffect, useRef } from "react";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { isElectronAvailable } from "@/hooks/useElectron";
import { terminalClient } from "@/clients/terminalClient";
import { goToPanel } from "@/lib/watchNotification";
import { isTerminalRestarting } from "@/store/restartExitSuppression";
import { clientErrorText } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
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
    const unsubscribe = window.electron.events.on(
      "terminal:memory-leak-restart-requested",
      (request) => {
        safeFireAndForget(handleMemoryLeakRestartRequest(request), {
          context: "Memory-leak auto-restart",
        });
      }
    );
    // A recovered host replays its terminals as new processes, which the
    // failures reported against the old ones no longer describe.
    const unsubscribeRecovery = terminalClient.onBackendReady(() => reportedFailures.clear());
    return () => {
      unsubscribe();
      unsubscribeRecovery();
      reportedFailures.clear();
    };
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
  | { kind: "unconfirmed" }
  | { kind: "skipped" }
  | { kind: "gone" };

/** An answer for a later restart than this one: the pane is no longer this attempt's. */
const SUPERSEDED = "superseded";

/**
 * The failure this policy last reported per terminal, with the restart count it
 * left the pane on. A failed validation leaves the old process running, so the
 * host asks again every minute, and the same failure is reported once.
 */
const reportedFailures = new Map<string, { restartKey: number; reason: string }>();

export function resetMemoryRestartReportsForTests(): void {
  reportedFailures.clear();
}

function restartKeyOf(terminalId: string): number | undefined {
  const panel = usePanelStore.getState().panelsById[terminalId];
  return panel && isPtyPanel(panel) ? (panel.restartKey ?? 0) : undefined;
}

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
  // refused; it must not take that one's outcome as its own. The marker is set
  // before the store flag, across the restart's first await.
  if (terminal.isRestarting || isTerminalRestarting(terminalId)) return;

  // Armed before the restart: the host's answer can arrive ahead of the
  // spawn's own reply.
  const answer = listenForSpawnAnswer(terminalId, terminal.restartKey ?? 0);
  try {
    const outcome = await restartForMemory(terminal, answer.result);
    reportRestart(terminal, thresholdMb, outcome);
  } finally {
    answer.dispose();
  }
}

async function restartForMemory(
  before: PtyPanelData,
  answer: Promise<SpawnResult | typeof SUPERSEDED>
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
  const restartKey = before.restartKey ?? 0;
  const keyNow = after.restartKey ?? 0;
  if (keyNow === restartKey) return { kind: "skipped" };
  if (keyNow !== restartKey + 1) return { kind: "gone" };
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
  // A restart after this one, or a close, owns the pane now.
  if (result === SUPERSEDED || restartKeyOf(before.id) !== restartKey + 1) return { kind: "gone" };
  // Main's own report of a host that hasn't answered yet: the spawn may still land.
  if (result === null || (!result.success && result.error?.code === "SPAWN_TIMEOUT")) {
    return { kind: "unconfirmed" };
  }
  if (!result.success) {
    return { kind: "failed", reason: result.error?.message ?? "Failed to start terminal process" };
  }
  return { kind: "restarted" };
}

/**
 * The host's first answer for the terminal once this restart has moved the
 * pane's restart count, until disposed. The process being replaced was
 * answered for long before it ran over the threshold, and no other restart
 * starts while this one runs, so an answer at this attempt's count is its own.
 */
function listenForSpawnAnswer(
  terminalId: string,
  restartKey: number
): { result: Promise<SpawnResult | typeof SUPERSEDED>; dispose: () => void } {
  let settle: (answer: SpawnResult | typeof SUPERSEDED) => void = () => {};
  const result = new Promise<SpawnResult | typeof SUPERSEDED>((resolve) => {
    settle = resolve;
  });
  let unsubscribe: (() => void) | null = terminalClient.onSpawnResult((id, spawnResult) => {
    if (id !== terminalId) return;
    const keyNow = restartKeyOf(terminalId);
    if (keyNow === restartKey) return;
    settle(keyNow === restartKey + 1 ? spawnResult : SUPERSEDED);
    dispose();
  });
  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }
  return { result, dispose };
}

function reportRestart(before: PtyPanelData, thresholdMb: number, outcome: RestartOutcome): void {
  const terminalId = before.id;
  const panel = usePanelStore.getState().panelsById[terminalId];
  // Closed, or taken over by another restart: there is nothing left to report on.
  if (outcome.kind === "gone" || !panel || !isPtyPanel(panel) || panel.location === "trash") {
    reportedFailures.delete(terminalId);
    return;
  }
  for (const id of reportedFailures.keys()) {
    if (!usePanelStore.getState().panelsById[id]) reportedFailures.delete(id);
  }

  if (outcome.kind === "failed") {
    const restartKey = panel.restartKey ?? 0;
    const last = reportedFailures.get(terminalId);
    reportedFailures.set(terminalId, { restartKey, reason: outcome.reason });
    if (last?.restartKey === restartKey && last.reason === outcome.reason) {
      logWarn("[MemoryLeak] Auto-restart failed again", { terminalId, reason: outcome.reason });
      return;
    }
  } else {
    reportedFailures.delete(terminalId);
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
    // Named so a live leak warning this merges into (same correlationId) keeps
    // none of its own buttons beside this outcome's.
    action: undefined,
    actions: undefined,
  };
  const goToTerminal = {
    label: "Go to terminal",
    successLabel: "Opened",
    actionId: "panel.focus" as const,
    actionArgs: { panelId: terminalId },
    onClick: () => goToPanel(terminalId),
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
        message: outcome.reason,
        inboxMessage: `Couldn't auto-restart ${title} after RSS exceeded ${threshold}: ${outcome.reason}`,
        action: goToTerminal,
      });
      return;
    case "unconfirmed":
      notify({
        ...shared,
        type: "warning",
        title: `Auto-restart unconfirmed \u2014 ${title}`,
        message: "The terminal backend hasn't confirmed the replacement process yet.",
        inboxMessage: `Auto-restart of ${title} unconfirmed after RSS exceeded ${threshold}`,
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
