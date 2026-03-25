import { useEffect, useMemo, useState } from "react";
import type { WorktreeState } from "@/types";

const MAIN_WORKTREE_NOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type SpineState = "dirty" | "current" | "stale" | "idle";

export type WorktreeLifecycleStage = "in-review" | "merged" | "ready-for-cleanup";

export type ComputedSubtitleTone = "warning" | "info" | "muted";

export interface ComputedSubtitle {
  text: string;
  tone: ComputedSubtitleTone;
}

export interface UseWorktreeStatusResult {
  branchLabel: string;
  hasChanges: boolean;
  isComplete: boolean;
  lifecycleStage: WorktreeLifecycleStage | null;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  computedSubtitle: ComputedSubtitle;
  spineState: SpineState;
  isLifecycleRunning: boolean;
  lifecycleLabel?: string;
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

  const branchLabel = isMainWorktree ? worktree.name : (worktree.branch ?? worktree.name);
  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;

  const rawLastCommitMessage = worktree.worktreeChanges?.lastCommitMessage;
  const firstLineLastCommitMessage = rawLastCommitMessage?.split("\n")[0].trim();

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

  const computedSubtitle = useMemo((): ComputedSubtitle => {
    if (hasChanges && worktree.worktreeChanges) {
      return { text: "", tone: "warning" };
    }

    if (firstLineLastCommitMessage) {
      return { text: firstLineLastCommitMessage, tone: "muted" };
    }

    if (worktree.prTitle?.trim() && worktree.prState !== "closed") {
      return { text: worktree.prTitle.trim(), tone: "muted" };
    }

    return { text: "No recent activity", tone: "muted" };
  }, [
    hasChanges,
    worktree.worktreeChanges,
    firstLineLastCommitMessage,
    worktree.prTitle,
    worktree.prState,
  ]);

  const spineState: SpineState = useMemo(() => {
    if (hasChanges) return "dirty";
    if (worktree.isCurrent) return "current";
    if (worktree.mood === "stale") return "stale";
    return "idle";
  }, [hasChanges, worktree.isCurrent, worktree.mood]);

  const isComplete =
    !!worktree.issueNumber &&
    !!worktree.prNumber &&
    !hasChanges &&
    worktree.worktreeChanges !== null;

  const lifecycleStage = useMemo((): WorktreeLifecycleStage | null => {
    if (isMainWorktree) return null;
    if (worktree.worktreeChanges === null) return null;

    if (worktree.prState === "merged") {
      return worktree.issueNumber ? "ready-for-cleanup" : "merged";
    }

    if (worktree.prState === "open") return "in-review";

    return null;
  }, [isMainWorktree, worktree.worktreeChanges, worktree.prState, worktree.issueNumber]);

  const lifecycle = worktree.lifecycleStatus;
  const isLifecycleRunning = lifecycle?.state === "running";
  const lifecycleLabel = useMemo(() => {
    if (!lifecycle) return undefined;
    if (lifecycle.state === "running") {
      const phase = lifecycle.phase === "setup" ? "Running setup" : "Running teardown";
      if (lifecycle.currentCommand) {
        return `${phase}: ${lifecycle.currentCommand}`;
      }
      return `${phase}...`;
    }
    if (lifecycle.state === "failed") {
      return lifecycle.phase === "setup" ? "Setup failed" : "Teardown failed";
    }
    if (lifecycle.state === "timed-out") {
      return lifecycle.phase === "setup" ? "Setup timed out" : "Teardown timed out";
    }
    return undefined;
  }, [lifecycle]);

  return {
    branchLabel,
    hasChanges,
    isComplete,
    lifecycleStage,
    effectiveNote,
    effectiveSummary,
    computedSubtitle,
    spineState,
    isLifecycleRunning,
    lifecycleLabel,
  };
}
