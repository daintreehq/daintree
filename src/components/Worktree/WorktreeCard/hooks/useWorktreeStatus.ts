import { useEffect, useMemo, useState } from "react";
import type { WorktreeState } from "@/types";
import { isStandardBranch } from "@shared/config/branchPrefixes";

const MAIN_WORKTREE_NOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type SpineState = "dirty" | "current" | "stale" | "idle";

export type WorktreeLifecycleStage = "in-review" | "merged" | "ready-for-cleanup";

export type ComputedSubtitleTone = "warning" | "info" | "muted";

export interface ComputedSubtitle {
  text: string;
  tone: ComputedSubtitleTone;
}

export type WorktreeReviewState = "conflicted" | "unpushed-clean" | "has-changes" | null;

export type ResourceStatusColor = "green" | "yellow" | "red" | "neutral";

export type GitStateKind =
  | "conflicted"
  | "rebasing"
  | "merging"
  | "cherry-picking"
  | "reverting"
  | "detached"
  | "dirty";

export interface GitStateIndicator {
  kind: GitStateKind;
  label: string;
  tone: "error" | "warning" | "info";
}

const REPO_STATE_TO_KIND: Record<string, GitStateKind> = {
  REBASING: "rebasing",
  MERGING: "merging",
  CHERRY_PICKING: "cherry-picking",
  REVERTING: "reverting",
};

const GIT_STATE_LABELS: Record<GitStateKind, string> = {
  conflicted: "conflicted",
  rebasing: "rebasing",
  merging: "merging",
  "cherry-picking": "cherry-picking",
  reverting: "reverting",
  detached: "detached",
  dirty: "dirty",
};

export interface UseWorktreeStatusResult {
  branchLabel: string;
  isMainOnStandardBranch: boolean;
  hasChanges: boolean;
  isComplete: boolean;
  lifecycleStage: WorktreeLifecycleStage | null;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  computedSubtitle: ComputedSubtitle;
  reviewState: WorktreeReviewState;
  spineState: SpineState;
  isLifecycleRunning: boolean;
  lifecycleLabel?: string;
  resourceStatusLabel?: string;
  resourceStatusColor?: ResourceStatusColor;
  hasResourceConfig: boolean;
  gitStateIndicator: GitStateIndicator | null;
}

export function useWorktreeStatus({
  worktree,
}: {
  worktree: WorktreeState;
}): UseWorktreeStatusResult {
  const [now, setNow] = useState(() => Date.now());
  const isMainWorktree = worktree.isMainWorktree;

  useEffect(() => {
    if (!isMainWorktree || !worktree.aiNote || !worktree.aiNoteTimestamp) {
      return;
    }

    const expiresAt = worktree.aiNoteTimestamp + MAIN_WORKTREE_NOTE_TTL_MS;
    const timeUntilExpiry = expiresAt - Date.now();

    if (timeUntilExpiry <= 0) {
      setNow(Date.now());
      return;
    }

    const timer = setTimeout(() => {
      setNow(Date.now());
    }, timeUntilExpiry);

    return () => clearTimeout(timer);
  }, [isMainWorktree, worktree.aiNote, worktree.aiNoteTimestamp]);

  const effectiveNote = useMemo(() => {
    const trimmed = worktree.aiNote?.trim();
    if (!trimmed) return undefined;

    if (isMainWorktree && worktree.aiNoteTimestamp) {
      const age = now - worktree.aiNoteTimestamp;
      if (age > MAIN_WORKTREE_NOTE_TTL_MS) {
        return undefined;
      }
    }

    return trimmed;
  }, [worktree.aiNote, isMainWorktree, worktree.aiNoteTimestamp, now]);

  const isMainOnStandardBranch = !!(
    isMainWorktree &&
    worktree.branch &&
    !worktree.isDetached &&
    isStandardBranch(worktree.branch)
  );

  let branchLabel: string;
  if (isMainWorktree) {
    if (!worktree.branch || worktree.isDetached) {
      branchLabel = worktree.name;
    } else {
      branchLabel = worktree.branch;
    }
  } else {
    branchLabel = worktree.branch ?? worktree.name;
  }
  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;

  const rawLastCommitMessage = worktree.worktreeChanges?.lastCommitMessage;
  const firstLineLastCommitMessage = rawLastCommitMessage?.split("\n")[0]?.trim();

  const isSummarySameAsCommit = useMemo(() => {
    if (!worktree.summary || !rawLastCommitMessage) return false;
    const s = worktree.summary.trim().toLowerCase();
    const c = rawLastCommitMessage.trim().toLowerCase();
    const firstLineC = firstLineLastCommitMessage?.toLowerCase();
    return (
      s === c ||
      s.includes(c) ||
      c.includes(s) ||
      (firstLineC && (s === firstLineC || s.includes(firstLineC)))
    );
  }, [worktree.summary, rawLastCommitMessage, firstLineLastCommitMessage]);

  const effectiveSummary = isSummarySameAsCommit ? null : worktree.summary;

  const computedSubtitle: ComputedSubtitle = (() => {
    if (hasChanges && worktree.worktreeChanges) {
      return { text: "", tone: "warning" };
    }

    if (firstLineLastCommitMessage) {
      return { text: firstLineLastCommitMessage, tone: "muted" };
    }

    const prTitle = worktree.linked?.pr?.title?.trim();
    const prState = worktree.linked?.pr?.state;
    if (prTitle && prState !== "closed" && prState !== "declined") {
      return { text: prTitle, tone: "muted" };
    }

    return { text: "No recent activity", tone: "muted" };
  })();

  const spineState: SpineState = useMemo(() => {
    if (hasChanges) return "dirty";
    if (worktree.isCurrent) return "current";
    if (worktree.mood === "stale") return "stale";
    return "idle";
  }, [hasChanges, worktree.isCurrent, worktree.mood]);

  const gitStateIndicator: GitStateIndicator | null = useMemo(() => {
    // Priority: conflicted > blocking operation > detached > dirty
    if (worktree.worktreeChanges?.changes?.some((c) => c.status === "conflicted")) {
      return { kind: "conflicted", label: GIT_STATE_LABELS.conflicted, tone: "error" };
    }
    if (worktree.repoState) {
      const kind = REPO_STATE_TO_KIND[worktree.repoState];
      if (kind) {
        return { kind, label: GIT_STATE_LABELS[kind], tone: "warning" };
      }
    }
    if (worktree.isDetached) {
      return { kind: "detached", label: GIT_STATE_LABELS.detached, tone: "warning" };
    }
    if (hasChanges) {
      return { kind: "dirty", label: GIT_STATE_LABELS.dirty, tone: "info" };
    }
    return null;
  }, [worktree.worktreeChanges?.changes, worktree.repoState, worktree.isDetached, hasChanges]);

  const reviewState: WorktreeReviewState = useMemo(() => {
    const changes = worktree.worktreeChanges;
    if (!changes) return null;
    if (changes.changes?.some((c) => c.status === "conflicted")) return "conflicted";
    if ((changes.changedFileCount ?? 0) > 0) return "has-changes";
    if ((changes.ahead ?? 0) > 0) return "unpushed-clean";
    return null;
  }, [worktree.worktreeChanges]);

  const isComplete =
    !!worktree.issueNumber &&
    !!worktree.linked?.pr &&
    !hasChanges &&
    worktree.worktreeChanges !== null;

  const lifecycleStage = useMemo((): WorktreeLifecycleStage | null => {
    if (isMainWorktree) return null;
    if (worktree.worktreeChanges === null) return null;

    if (worktree.linked?.pr?.state === "merged") {
      return worktree.issueNumber ? "ready-for-cleanup" : "merged";
    }

    if (worktree.linked?.pr?.state === "open") return "in-review";

    return null;
  }, [isMainWorktree, worktree.worktreeChanges, worktree.linked?.pr?.state, worktree.issueNumber]);

  const lifecycle = worktree.lifecycleStatus;
  const isLifecycleRunning = lifecycle?.state === "running";
  const lifecycleLabel = useMemo(() => {
    if (!lifecycle) return undefined;

    const PHASE_LABELS: Record<string, string> = {
      setup: "Running setup",
      teardown: "Running teardown",
      "resource-provision": "Provisioning resource",
      "resource-teardown": "Tearing down resource",
      "resource-resume": "Resuming resource",
      "resource-pause": "Pausing resource",
      "resource-status": "Checking resource status",
    };

    if (lifecycle.state === "running") {
      const phase = PHASE_LABELS[lifecycle.phase] ?? lifecycle.phase;
      if (lifecycle.currentCommand) {
        return `${phase}: ${lifecycle.currentCommand}`;
      }
      return `${phase}...`;
    }
    if (lifecycle.state === "failed") {
      const phase = PHASE_LABELS[lifecycle.phase] ?? lifecycle.phase;
      return `${phase.replace(/^(Running |Provisioning |Tearing down |Resuming |Pausing |Checking )/, "")} failed`;
    }
    if (lifecycle.state === "timed-out") {
      const phase = PHASE_LABELS[lifecycle.phase] ?? lifecycle.phase;
      return `${phase.replace(/^(Running |Provisioning |Tearing down |Resuming |Pausing |Checking )/, "")} timed out`;
    }
    return undefined;
  }, [lifecycle]);

  const KNOWN_STATUS_COLORS: Record<string, ResourceStatusColor> = {
    running: "green",
    healthy: "green",
    ready: "green",
    up: "green",
    starting: "yellow",
    provisioning: "yellow",
    unhealthy: "red",
    down: "red",
    error: "red",
    failed: "red",
    paused: "neutral",
    stopped: "neutral", // graceful fallback — prefer "paused"
    stopping: "neutral",
    unknown: "neutral",
  };

  // Synthesize resource status from lifecycle phase when a lifecycle action is in-flight.
  // This prevents showing a stale "down" or null status while provisioning/resuming/pausing.
  const LIFECYCLE_PHASE_STATUS: Partial<Record<string, string>> = {
    "resource-provision": "provisioning",
    "resource-resume": "starting",
    "resource-pause": "paused",
    "resource-teardown": "stopping",
  };
  const lifecyclePhaseStatus =
    isLifecycleRunning && lifecycle ? LIFECYCLE_PHASE_STATUS[lifecycle.phase] : undefined;

  const resourceStatus = lifecyclePhaseStatus ?? worktree.resourceStatus?.lastStatus;
  const hasResourceConfig = !!worktree.hasResourceConfig;
  const resourceStatusLabel = resourceStatus ?? undefined;
  const resourceStatusColor: ResourceStatusColor | undefined = resourceStatus
    ? (KNOWN_STATUS_COLORS[resourceStatus.toLowerCase()] ?? "neutral")
    : undefined;

  return {
    branchLabel,
    isMainOnStandardBranch,
    hasChanges,
    isComplete,
    lifecycleStage,
    effectiveNote,
    effectiveSummary,
    computedSubtitle,
    reviewState,
    spineState,
    isLifecycleRunning,
    lifecycleLabel,
    resourceStatusLabel,
    resourceStatusColor,
    hasResourceConfig,
    gitStateIndicator,
  };
}
