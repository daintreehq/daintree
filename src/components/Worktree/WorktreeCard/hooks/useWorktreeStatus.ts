import { useEffect, useMemo, useState } from "react";
import type { WorktreeState } from "@/types";

const MAIN_WORKTREE_NOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type SpineState = "error" | "dirty" | "current" | "stale" | "idle";

export type ComputedSubtitleTone = "error" | "warning" | "info" | "muted";

export interface ComputedSubtitle {
  text: string;
  tone: ComputedSubtitleTone;
}

export interface UseWorktreeStatusResult {
  branchLabel: string;
  hasChanges: boolean;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  computedSubtitle: ComputedSubtitle;
  spineState: SpineState;
}

export function useWorktreeStatus({
  worktree,
  worktreeErrorCount,
}: {
  worktree: WorktreeState;
  worktreeErrorCount: number;
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

  const branchLabel = worktree.branch ?? worktree.name;
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
    if (worktreeErrorCount > 0) {
      return {
        text: worktreeErrorCount === 1 ? "1 error" : `${worktreeErrorCount} errors`,
        tone: "error",
      };
    }

    if (hasChanges && worktree.worktreeChanges) {
      return { text: "", tone: "warning" };
    }

    if (firstLineLastCommitMessage) {
      return { text: firstLineLastCommitMessage, tone: "muted" };
    }

    return { text: "No recent activity", tone: "muted" };
  }, [worktreeErrorCount, hasChanges, worktree.worktreeChanges, firstLineLastCommitMessage]);

  const spineState: SpineState = useMemo(() => {
    if (worktreeErrorCount > 0 || worktree.mood === "error") return "error";
    if (hasChanges) return "dirty";
    if (worktree.isCurrent) return "current";
    if (worktree.mood === "stale") return "stale";
    return "idle";
  }, [worktreeErrorCount, worktree.mood, hasChanges, worktree.isCurrent]);

  return {
    branchLabel,
    hasChanges,
    effectiveNote,
    effectiveSummary,
    computedSubtitle,
    spineState,
  };
}
