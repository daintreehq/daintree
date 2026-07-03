import { create } from "zustand";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { isTerminalFleetEligible } from "@/store/fleetEligibility";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isPtyPanel } from "@shared/types/panel";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetExecutionResult } from "@/components/Fleet/fleetExecution";
import {
  RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH,
  RUN_HISTORY_REASON_MAX_LENGTH,
} from "@shared/types/ipc/runHistory";

/**
 * Supervised fleet-run model (#10930). A "run" is one structured broadcast
 * (Enter path or retry) tracked past submission: after the bytes land, the
 * run enters a `watching` phase that follows each target's agent state until
 * every target settles (leaves working/directing), then finalizes and appends
 * a durable run-history record. Layered over the existing primitives — the
 * broadcast/progress/failure stores keep their jobs; this store owns the
 * per-run, per-target lifecycle the ribbon and `fleet.getRunStatus` render.
 *
 * All agent-state fields are point-in-time snapshots of `usePanelStore` truth
 * copied in by the watcher (`subscribeFleetRunWatcher`) — the store never
 * becomes an independent source of terminal state, and nothing here persists;
 * the durable artifact is the run-history record appended at finalize.
 */

export type FleetRunStatus =
  | "submitting"
  | "watching"
  | "completed"
  | "cancelled"
  | "failed"
  | "superseded";

export type FleetRunSubmissionStatus = "pending" | "sent" | "failed" | "skipped";

export interface FleetRunTarget {
  terminalId: string;
  /** Pane title snapshotted at run start so the record stays legible after close. */
  title: string;
  worktreeId: string | null;
  submission: FleetRunSubmissionStatus;
  /** Set only when `submission === "failed"` — mirrors `classifyFleetRejectionReason`. */
  failureKind?: "permanent" | "transient";
  failureReason?: string;
  /** Live agent-state snapshot, updated by the watcher until the run finalizes. */
  agentState: AgentState | null;
  waitingReason?: WaitingReason;
  exitCode?: number | null;
  /**
   * A settled target no longer blocks run completion: its submission failed or
   * was skipped, its panel went away, or its agent left working/directing.
   * `waiting` counts as settled — the agent stopped to ask the user something,
   * which is exactly the supervision signal, mirroring `waitUntilIdleBatch`.
   * Ratchets true; never un-settles when an agent later resumes working.
   */
  settled: boolean;
  /** Panel disappeared (closed/trashed/lost PTY) while the run was live. */
  gone: boolean;
}

export interface FleetRun {
  runId: string;
  status: FleetRunStatus;
  /** True when this run was started by `fleet.retryFailures`. */
  isRetry: boolean;
  draftPreview: string;
  startedAt: number;
  endedAt?: number;
  targets: FleetRunTarget[];
}

export interface FleetRunCounts {
  total: number;
  sent: number;
  sendFailed: number;
  skipped: number;
  /** Sent targets still in working/directing. */
  working: number;
  /** Sent targets settled in `waiting` — the agent stopped for user input. */
  waiting: number;
  /** Sent targets settled anywhere else (completed/exited/idle/gone). */
  done: number;
}

export function summarizeFleetRun(run: FleetRun): FleetRunCounts {
  const counts: FleetRunCounts = {
    total: run.targets.length,
    sent: 0,
    sendFailed: 0,
    skipped: 0,
    working: 0,
    waiting: 0,
    done: 0,
  };
  for (const t of run.targets) {
    if (t.submission === "failed") {
      counts.sendFailed += 1;
      continue;
    }
    if (t.submission === "skipped" || t.submission === "pending") {
      counts.skipped += 1;
      continue;
    }
    counts.sent += 1;
    if (!t.settled) {
      counts.working += 1;
    } else if (t.agentState === "waiting" && !t.gone) {
      counts.waiting += 1;
    } else {
      counts.done += 1;
    }
  }
  return counts;
}

interface FleetRunState {
  run: FleetRun | null;
  /**
   * Start a new run over the given targets, superseding (and recording) any
   * run still in flight. Duplicate ids are dropped defensively — the armed
   * set is unique by construction, but retry/action callers pass raw arrays.
   */
  beginRun: (targetIds: string[], input: { draft: string; isRetry?: boolean }) => string;
  /**
   * Fold the broadcast submission outcome into the run: per-target sent/failed,
   * skipped for targets whose batch never fired. Transitions the run to
   * `watching`, or finalizes it as `cancelled`/`failed` when there is nothing
   * left to watch.
   */
  applySubmissionResult: (runId: string, result: FleetExecutionResult) => void;
  /**
   * Refresh agent-state snapshots for a watching run from the live panel
   * registry and finalize as `completed` once every target has settled.
   * Called by `subscribeFleetRunWatcher` on panel-store changes.
   */
  reconcile: () => void;
  /** Drop a finalized run from the UI. No-op while a run is still in flight. */
  dismiss: () => void;
  /** Test-only full reset. */
  _reset: () => void;
}

function isRunActive(run: FleetRun | null): run is FleetRun {
  return run !== null && (run.status === "submitting" || run.status === "watching");
}

function isBusyState(state: AgentState | null): boolean {
  return state === "working" || state === "directing";
}

function snapshotTarget(terminalId: string): FleetRunTarget {
  const panel = getNarrowPanel(usePanelStore.getState().panelsById, terminalId);
  return {
    terminalId,
    title: panel?.title ?? "Terminal",
    worktreeId: panel?.worktreeId ?? null,
    submission: "pending",
    agentState: panel && isPtyPanel(panel) ? (panel.agentState ?? null) : null,
    settled: false,
    gone: false,
  };
}

/**
 * Re-snapshot one target from the live panel registry. Pure with respect to
 * inputs; returns the same reference when nothing changed so `reconcile` can
 * skip no-op store updates.
 */
function refreshTarget(target: FleetRunTarget): FleetRunTarget {
  if (target.submission !== "sent") return target;
  const panel = getNarrowPanel(usePanelStore.getState().panelsById, target.terminalId);
  if (!isTerminalFleetEligible(panel)) {
    if (target.gone && target.settled) return target;
    return { ...target, gone: true, settled: true };
  }
  const agentState = panel.agentState ?? null;
  const waitingReason = agentState === "waiting" ? panel.waitingReason : undefined;
  const exitCode = panel.exitCode ?? null;
  const settled = target.settled || !isBusyState(agentState);
  if (
    agentState === target.agentState &&
    waitingReason === target.waitingReason &&
    exitCode === (target.exitCode ?? null) &&
    settled === target.settled
  ) {
    return target;
  }
  const next: FleetRunTarget = { ...target, agentState, exitCode, settled };
  if (waitingReason !== undefined) next.waitingReason = waitingReason;
  else delete next.waitingReason;
  return next;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Append the finalized run to the durable run-history ring (#9949). Guarded
 * and fire-and-forget: history is telemetry, never allowed to disrupt the
 * broadcast UX, and unit environments may not stub the namespace.
 */
function recordRunHistory(run: FleetRun): void {
  const append = window.electron?.runHistory?.append;
  if (!append) return;
  const counts = summarizeFleetRun(run);
  const status =
    run.status === "completed" ||
    run.status === "cancelled" ||
    run.status === "failed" ||
    run.status === "superseded"
      ? run.status
      : undefined;
  safeFireAndForget(
    append({
      kind: "fleet",
      runId: run.runId,
      status,
      isRetry: run.isRetry ? true : undefined,
      draftPreview: run.draftPreview,
      targetCount: run.targets.length,
      successCount: counts.sent,
      failureCount: counts.sendFailed,
      cancelled: run.status === "cancelled",
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      perTarget: run.targets
        .filter((t) => t.submission === "sent" || t.submission === "failed")
        .map((t) => ({
          terminalId: t.terminalId,
          title: t.title,
          status: t.submission === "sent" ? ("fulfilled" as const) : ("rejected" as const),
          reason: t.failureReason,
          failureKind: t.failureKind,
          finalAgentState: t.submission === "sent" ? (t.agentState ?? undefined) : undefined,
        })),
    }),
    { context: "Failed to record fleet run history" }
  );
}

function finalizeRun(run: FleetRun, status: FleetRunStatus): FleetRun {
  const finalized: FleetRun = { ...run, status, endedAt: Date.now() };
  recordRunHistory(finalized);
  return finalized;
}

/** Map per-target broadcast outcomes onto run targets: sent / failed / skipped. */
function foldSubmissionOutcomes(
  targets: FleetRunTarget[],
  result: FleetExecutionResult
): FleetRunTarget[] {
  const outcomes = new Map(result.perTarget.map((t) => [t.terminalId, t]));
  return targets.map((target) => {
    const outcome = outcomes.get(target.terminalId);
    if (!outcome) {
      // Batch never fired (cancelled mid-run). Already-dispatched input
      // can't be revoked, but these targets verifiably received nothing.
      return { ...target, submission: "skipped" as const, settled: true };
    }
    if (outcome.status === "fulfilled") {
      return { ...target, submission: "sent" as const };
    }
    const failed: FleetRunTarget = {
      ...target,
      submission: "failed",
      settled: true,
      failureKind: outcome.kind ?? "transient",
    };
    if (outcome.reason !== undefined) {
      failed.failureReason = clamp(outcome.reason, RUN_HISTORY_REASON_MAX_LENGTH);
    }
    return failed;
  });
}

/**
 * Runs superseded while their broadcast was still submitting, keyed by runId.
 * They are held out of the store (invisible to the UI) and recorded only when
 * the pre-empted broadcast's submission result lands — every begun run
 * receives exactly one `applySubmissionResult` call (the try or catch path in
 * `runManagedFleetBroadcast`), so entries are guaranteed to drain and the
 * superseded history record carries real per-target outcomes instead of
 * all-pending placeholders.
 */
const supersededAwaitingResult = new Map<string, FleetRun>();

export const useFleetRunStore = create<FleetRunState>((set, get) => ({
  run: null,

  beginRun: (targetIds, input) => {
    const previous = get().run;
    if (isRunActive(previous)) {
      // A new broadcast pre-empts the in-flight one (same rule as the shared
      // single-flight controller). A watching run already has its submission
      // outcomes — record it now. A still-submitting run doesn't: hold it
      // aside un-recorded until its (stale) submission result arrives, so the
      // superseded record isn't written with all-pending targets.
      if (previous.status === "submitting") {
        supersededAwaitingResult.set(previous.runId, {
          ...previous,
          status: "superseded",
          endedAt: Date.now(),
        });
      } else {
        finalizeRun(previous, "superseded");
      }
    }
    const seen = new Set<string>();
    const targets: FleetRunTarget[] = [];
    for (const id of targetIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push(snapshotTarget(id));
    }
    const run: FleetRun = {
      runId: crypto.randomUUID(),
      status: "submitting",
      isRetry: input.isRetry === true,
      draftPreview: clamp(input.draft, RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH),
      startedAt: Date.now(),
      targets,
    };
    set({ run });
    return run.runId;
  },

  applySubmissionResult: (runId, result) => {
    // A pre-empted broadcast reporting in for its superseded run: fold the
    // outcomes into the held record and append it now — this is the exactly-
    // once history write beginRun deferred.
    const held = supersededAwaitingResult.get(runId);
    if (held !== undefined) {
      supersededAwaitingResult.delete(runId);
      recordRunHistory({
        ...held,
        targets: foldSubmissionOutcomes(held.targets, result).map(refreshTarget),
      });
      return;
    }

    const run = get().run;
    if (!run || run.runId !== runId || run.status !== "submitting") return;

    // Immediate settle pass after folding: a target whose agent is already at
    // rest (fast command, dead pane) must not hold the run in `watching`
    // until the next panel-store change.
    const targets = foldSubmissionOutcomes(run.targets, result).map(refreshTarget);

    const anySent = targets.some((t) => t.submission === "sent");
    const allSettled = targets.every((t) => t.settled);
    let next: FleetRun = { ...run, targets };
    if (result.cancelled) {
      next = finalizeRun(next, "cancelled");
    } else if (!anySent) {
      next = finalizeRun(next, "failed");
    } else if (allSettled) {
      next = finalizeRun(next, "completed");
    } else {
      next = { ...next, status: "watching" };
    }
    set({ run: next });
  },

  reconcile: () => {
    const run = get().run;
    if (!run || run.status !== "watching") return;
    let changed = false;
    const targets = run.targets.map((target) => {
      const next = refreshTarget(target);
      if (next !== target) changed = true;
      return next;
    });
    if (!changed) return;
    if (targets.every((t) => t.settled)) {
      const finalized = finalizeRun({ ...run, targets }, "completed");
      // A run that finishes after the user already exited fleet mode records
      // its history and announces, but leaves no summary line — re-arming a
      // fresh fleet later must not resurface a stale "Run finished".
      const fleetDrained = useFleetArmingStore.getState().armedIds.size === 0;
      set({ run: fleetDrained ? null : finalized });
      const counts = summarizeFleetRun(finalized);
      const waiting = counts.waiting > 0 ? ` — ${counts.waiting} waiting for input` : "";
      useAnnouncerStore.getState().announce(`Fleet run finished${waiting}`, "polite");
      return;
    }
    set({ run: { ...run, targets } });
  },

  dismiss: () => {
    const run = get().run;
    if (run === null || isRunActive(run)) return;
    set({ run: null });
  },

  _reset: () => {
    supersededAwaitingResult.clear();
    set({ run: null });
  },
}));

/**
 * Panel-store watcher driving the `watching` phase, plus fleet-drain cleanup.
 * Registered by `initStoreOrchestrator()` so the subscriptions are scoped to
 * the renderer lifecycle (HMR/test-teardown safe), mirroring
 * `subscribeFleetFailureAutoClear`. Runs an initial reconcile pass to catch
 * transitions that landed while the subscription was torn down.
 *
 * Drain semantics: exiting fleet mode dismisses a FINALIZED run summary (a
 * stale "Run finished" must not resurface on the next arming) but leaves an
 * in-flight `watching` run alone — its agents are still working, and the run
 * still owes its history record; `reconcile` clears the display at finalize
 * when the fleet is gone.
 */
export function subscribeFleetRunWatcher(): () => void {
  useFleetRunStore.getState().reconcile();
  if (useFleetArmingStore.getState().armedIds.size === 0) {
    useFleetRunStore.getState().dismiss();
  }

  let prevPanelsById = usePanelStore.getState().panelsById;
  const unsubscribePanels = usePanelStore.subscribe((state) => {
    if (state.panelsById === prevPanelsById) return;
    prevPanelsById = state.panelsById;
    useFleetRunStore.getState().reconcile();
  });

  let prevArmed = useFleetArmingStore.getState().armedIds;
  const unsubscribeArming = useFleetArmingStore.subscribe((state) => {
    if (state.armedIds === prevArmed) return;
    const drained = prevArmed.size > 0 && state.armedIds.size === 0;
    prevArmed = state.armedIds;
    if (drained) useFleetRunStore.getState().dismiss();
  });

  return () => {
    unsubscribePanels();
    unsubscribeArming();
  };
}
