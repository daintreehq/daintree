import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, type TerminalInstance } from "@/store/panelStore";
import { isFleetArmEligible } from "@/store/fleetArmingStore";
import { isTerminalVisible, useWorktreeIds } from "@/hooks/useTerminalSelectors";

export type ClusterType = "prompt" | "error" | "completion";

export interface ClusterGroup {
  type: ClusterType;
  signature: string;
  memberIds: string[];
  count: number;
  headline: string;
  priority: number;
  latestStateChange: number;
}

const PROMPT_PRIORITY = 1;
const ERROR_PRIORITY = 2;
const COMPLETION_PRIORITY = 3;
const COMPLETION_WINDOW_MS = 30_000;

function makeSignature(type: ClusterType, memberIds: string[], latestStateChange: number): string {
  const sorted = [...memberIds].sort();
  return `${type}:${sorted.join(",")}:${latestStateChange}`;
}

function makeHeadline(type: ClusterType, count: number): string {
  const noun = count === 1 ? "agent" : "agents";
  switch (type) {
    case "prompt":
      return `${count} ${noun} need${count === 1 ? "s" : ""} input`;
    case "error":
      return `${count} ${noun} exited with errors`;
    case "completion":
      return `${count} ${noun} finished`;
  }
}

function priorityFor(type: ClusterType): number {
  switch (type) {
    case "prompt":
      return PROMPT_PRIORITY;
    case "error":
      return ERROR_PRIORITY;
    case "completion":
      return COMPLETION_PRIORITY;
  }
}

interface BucketMember {
  id: string;
  lastStateChange: number;
}

interface DeriveParams {
  panelIds: string[];
  panelsById: Record<string, TerminalInstance | undefined>;
  isInTrash: (id: string) => boolean;
  worktreeIds: Set<string>;
  now: number;
}

/**
 * Pure cluster derivation. Scans eligible agent terminals in `panelIds` order
 * and returns the highest-priority cluster (≥2 members) or null.
 *
 * Priority: prompt (1) > error (2) > completion (3).
 * Tie-break: larger count → newer latestStateChange → lexical member-id order.
 */
export function deriveHighestPriorityCluster(params: DeriveParams): ClusterGroup | null {
  const { panelIds, panelsById, isInTrash, worktreeIds, now } = params;

  const buckets: Record<ClusterType, BucketMember[]> = {
    prompt: [],
    error: [],
    completion: [],
  };

  for (const id of panelIds) {
    const t = panelsById[id];
    if (!t) continue;
    if (!isFleetArmEligible(t)) continue;
    if (!isTerminalVisible(t, isInTrash, worktreeIds)) continue;

    const lsc =
      typeof t.lastStateChange === "number" && !Number.isNaN(t.lastStateChange)
        ? t.lastStateChange
        : 0;

    if (t.agentState === "waiting" && t.waitingReason === "prompt") {
      buckets.prompt.push({ id, lastStateChange: lsc });
      continue;
    }

    if (t.agentState === "exited" && typeof t.exitCode === "number" && t.exitCode !== 0) {
      buckets.error.push({ id, lastStateChange: lsc });
      continue;
    }

    if (
      t.agentState === "completed" &&
      typeof t.lastStateChange === "number" &&
      !Number.isNaN(t.lastStateChange) &&
      t.lastStateChange >= now - COMPLETION_WINDOW_MS
    ) {
      buckets.completion.push({ id, lastStateChange: lsc });
      continue;
    }
  }

  const candidates: ClusterGroup[] = [];
  for (const type of ["prompt", "error", "completion"] as const) {
    const members = buckets[type];
    if (members.length < 2) continue;
    const memberIds = members.map((m) => m.id);
    const latestStateChange = members.reduce(
      (acc, m) => (m.lastStateChange > acc ? m.lastStateChange : acc),
      0
    );
    candidates.push({
      type,
      memberIds,
      count: members.length,
      latestStateChange,
      priority: priorityFor(type),
      signature: makeSignature(type, memberIds, latestStateChange),
      headline: makeHeadline(type, members.length),
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.count !== b.count) return b.count - a.count;
    if (a.latestStateChange !== b.latestStateChange) {
      return b.latestStateChange - a.latestStateChange;
    }
    return a.memberIds.join(",").localeCompare(b.memberIds.join(","));
  });

  return candidates[0]!;
}

/**
 * React hook returning the highest-priority active agent cluster, or `null`
 * when no cluster of ≥2 eligible members exists.
 *
 * Follows the `useWaitingTerminals()` pattern: read raw store slices, then
 * derive in `useMemo`. No grouping logic runs inside the Zustand selector,
 * avoiding new-reference-per-call churn that would trigger re-renders on
 * every panel update.
 *
 * The `now` timestamp is captured once per render via `Date.now()`. The
 * completion window (30s) therefore dissolves lazily on the next panel
 * update — this is intentional: the issue spec requires piggybacking on
 * existing panel-store subscriptions and forbids new timers.
 */
export function useAgentClusters(): ClusterGroup | null {
  const panelIds = usePanelStore((state) => state.panelIds);
  const panelsById = usePanelStore(useShallow((state) => state.panelsById));
  const isInTrash = usePanelStore((state) => state.isInTrash);
  const worktreeIds = useWorktreeIds();

  return useMemo(
    () =>
      deriveHighestPriorityCluster({
        panelIds,
        panelsById,
        isInTrash,
        worktreeIds,
        now: Date.now(),
      }),
    [panelIds, panelsById, isInTrash, worktreeIds]
  );
}
